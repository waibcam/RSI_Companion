// open appropriate page based on url hash
var max_news_page = 1; // 10 news per page.
var nb_notification = 0;

const base_LIVE_Url = "https://robertsspaceindustries.com/";
const base_PTU_Url = "https://ptu.cloudimperiumgames.com/";

var connection_status = false;
var user_data = false;

var handle = false;

var Rsi_LIVE_Token = false;
var Rsi_PTU_Token = false;

var PreLoaded = false;

var News = [];


// Listener from background
chrome.runtime.onMessage.addListener(
	function bgListener (request, sender, sendResponse) {
		switch (request.type)
		{
			case "CheckConnection":
				CheckConnection(false, true, 'bgListener');
				sendResponse({success:true});
				break;
			default:
				sendResponse({success:true});
				break;
		}		
	}
);


function pre_load_data(hash, callback)
{
	PreLoaded = true;
	
	if (hash == "#page_Spectrum") callback();
	$('a.nav-link[href="#page_Spectrum"]').parent().removeClass('d-none');
	
	var elem = $('a.nav-link[href="#page_Comm_Link"]');
	elem.find('.badge').text(0);
	
	// Collecting Comm-Links (News)
	for (var page = 1; page <= max_news_page; page++) {
		
		chrome.runtime.sendMessage({
			type: 'getNews',
			Token: Rsi_LIVE_Token,
			page: page,
		}, (news_result) => {
			
			if (typeof news_result != "undefined")
			{
				News[news_result.page] = news_result;
			}
			
			if (news_result.page == max_news_page)
			{
				elem.find('.badge').text(max_news_page*10);
				if (hash == "" || hash == "#page_Comm_Link") callback();

				elem.parent().removeClass('d-none');
				
				// Get Ship list
				chrome.runtime.sendMessage({
					type: 'getShipList',
					Token: Rsi_LIVE_Token
				}, (ShipList) => {
					
					if (hash == "#page_Ships") callback();
					$('a.nav-link[href="#page_Ships"]').parent().removeClass('d-none');
					
					var ships = ShipList.data.ships;
					var loaners = ShipList.data.loaners;
					
					var nb_ships_owned = 0;
					var Ship_Status = [];
					var Ship_Focus = [];
					var Ship_Type = [];
					var Ship_Manufacturers = [];
					
					$(ships).each( (i, ship) => {
						if (ship.owned) nb_ships_owned++;
								
						if (ship.production_status !== null && ! Ship_Status.includes(ship.production_status.trim())) Ship_Status.push(ship.production_status.trim());
						if (ship.focus !== null && ! Ship_Focus.includes(ship.focus.trim())) Ship_Focus.push(ship.focus.trim());
						if (ship.type !== null && ! Ship_Type.includes(ship.type.trim())) Ship_Type.push(ship.type.trim());
						if (typeof(ship.manufacturer) != "undefined")
						{
							manufacturer = ship.manufacturer;
							manufacturer.name_lower = manufacturer.name.toLowerCase();
							Ship_Manufacturers[manufacturer.id] = manufacturer;
						}
					});
					
					$('select#Ship_Status, select#Ship_Focus, select#Ship_Type, select#Ship_Manufacturers').html('<option value="0" selected>None</option>');

					Ship_Status.sort();
					Ship_Focus.sort();
					Ship_Type.sort();
					Ship_Manufacturers.sortAscOn('name_lower');
					
					$(Ship_Status).each((i, Status) => {
						$('select#Ship_Status').append('<option value="' + Status + '">' + capitalizeFirstLetter(Status) + '</option>')
					});
					$(Ship_Focus).each((i, Focus) => {
						$('select#Ship_Focus').append('<option value="' + Focus + '">' + capitalizeFirstLetter(Focus) + '</option>')
					});
					$(Ship_Type).each((i, Type) => {
						$('select#Ship_Type').append('<option value="' + Type + '">' + capitalizeFirstLetter(Type) + '</option>')
					});
					$(Ship_Manufacturers).each( (i, Manufacturer) => {
						if (typeof(Manufacturer) != "undefined") $('select#Ship_Manufacturers').append('<option value="' + Manufacturer.id + '">' + Manufacturer.name + '</option>')
					});
					
					
					$('a.nav-link[href="#page_Ships"]').find('.badge').html(nb_ships_owned + "/" + ships.length);
					
					// Collecting Friend List
					chrome.runtime.sendMessage({
						type: 'getFriendList',
						LIVE: true,
						Token: Rsi_LIVE_Token,
					}, (FriendList) => {
						
						if (hash == "#page_Contacts") callback();
						$('a.nav-link[href="#page_Contacts"]').parent().removeClass('d-none');
						$('a.nav-link[href="#page_Contacts"]').find('.badge').html(FriendList.data.length);
						
						// Collecting Organization of current user
						chrome.runtime.sendMessage({
							type: 'getOrganizations',
						}, (Organizations) => {
							
							if (hash == "#page_Organizations") callback();
							$('a.nav-link[href="#page_Organizations"]').parent().removeClass('d-none');
							$('a.nav-link[href="#page_Organizations"]').find('.badge').html(Organizations.organizations.length);
							
							// Collecting Roadmap information
							chrome.runtime.sendMessage({
								type: 'getBoards',
							}, (Boards) => {
								
								if (hash == "#page_Roadmap") callback();
								$('a.nav-link[href="#page_Roadmap"]').parent().removeClass('d-none');
								$('a.nav-link[href="#page_Roadmap"]').find('.badge').html(Boards.data.boards.length);
								
								/*
								// Get Telemetry information
								chrome.runtime.sendMessage({
									type: 'getTelemetry',
									LIVE_Token: Rsi_LIVE_Token,
								}, (Telemetry) => {
									if (hash == "#page_Telemetry") callback();
									
									
									if (typeof Telemetry !== "undefined" && Telemetry.success == 1 && Telemetry.data.length > 0) $('a.nav-link[href="#page_Telemetry"]').parent().removeClass('d-none');
								});
								*/
							});
						});
					});
				});
			}
		});
	}
}


function setBadge (text, bg_color = false)
{
	chrome.runtime.sendMessage({
		type: 'setBadge',
		text: text,
		bg_color: bg_color,
	});
}


function get_notification (notification, message)
{
	time_ago = timeSince(notification.time);
	thumbnail = notification.thumbnail;
	
	link_path = notification.link_tokens.link_path.split('.');
	
	debug_needed = false;
	
	link_url = base_LIVE_Url+'spectrum';
	$(link_path).each(function(index, value){
		switch (value)
		{
			case "community":
				link_url += '/community/' + notification.link_tokens.community_slug;
				break;
			case "channel":
				link_url += '/forum/' + notification.link_tokens.channel_id;
				break;
			case "thread":
				link_url += '/thread/' + notification.link_tokens.thread_slug;
				break;
			case "reply":
				link_url += '/' + notification.link_tokens.reply_id;
				break;
			case "lobby":
				link_url += '/lobby/' + notification.link_tokens.lobby_id;
				break;
			case "private":
				link_url += '/messages/member/' + notification.link_tokens.member_id;
				break;
			case "friend":
				link_url += '/settings/friend-requests';
				break;
			default:
				console.log('MISSING case => "' + value);
				debug_needed = true;
				break;
		}
	});
	
	if (debug_needed)
	{
		console.log(notification.link_tokens.link_path);
		console.log(message);
		console.log('------------------------------------------------------------------------------------------------------');
	}
	
	
	if (typeof thumbnail == "undefined" || thumbnail == null) thumbnail = '../img/default_avatar.jpg';
	img = '<img src="' + thumbnail + '" class="img-fluid rounded mr-3" alt="User Avatar" style="width: 64px;"/>';
	
	return '' +
		'<li class="media p-1 mb-2 border-bottom' + (notification.unread?' unread bg-light text-dark':'') + '">' +
			img +
			'<div class="media-body">' +
				'<h6 class="mt-0 mb-1">' + time_ago + '</h6>' +
				'<a class="notifications-item" href="' + link_url + '" target="_blank" data-notification_id="' + notification.id + '">' + message + '</a>' +
			'</div>' +
		'</li>' +
	'';
	
}

function update_notification(data)
{
	elem = "#page_Spectrum";
	
	nb_notification = parseInt(data.nb_notification)
	
	if (nb_notification > 0)
	{
		setBadge(nb_notification);
		$('a.nav-link[href="' + elem + '"]').find('.badge').html(nb_notification);
	}
	else
	{
		setBadge("0");
		$('a.nav-link[href="' + elem + '"]').find('.badge').html('');
	}
	
	if (typeof data.notifications != "undefined")
	{
		var notifications = data.notifications;
		
		notifications.sortDescOn("time");
		
		$(elem).find('.content .notification .card-title > span').text('(' + nb_notification + '/' + notifications.length + ')');
		
		var container = $(elem).find('.content .notification ul.list-unstyled');
		container.html('');
		
		$(notifications).each(function (index, notification){
			
			if (notification.grouped) notification.type = notification.type + '.grouped';
			
			switch (notification.type)
			{
				case "friend-new-request":
					message = 'New friend request from <strong>' + notification.text_tokens.displayname + '</strong> is <em>"' + notification.text_tokens.plaintext + '"</em>';
					
					container.append(get_notification (notification, message));
					break;
				
				case "private-new-message":
					message = 'New Message from <strong>' + notification.text_tokens.displayname + '</strong>:<br /><em>"' + notification.text_tokens.plaintext + '"</em>';
					
					container.append(get_notification (notification, message));
					break;
				
				case "forum-channel-new-thread":
					// "forum-channel-new-thread" => "New thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> has been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>"

					message = 'New thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> has been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>';
					
					container.append(get_notification (notification, message));
					
				break;
					
				case "forum-channel-new-thread.grouped":
					// "forum-channel-new-thread.grouped":"<strong>' + notification.text_tokens.threads_count + ' new threads</strong> have been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>"

					message = '<strong>' + notification.text_tokens.threads_count + ' new thread' + (notification.text_tokens.threads_count>1?'s':'') + '</strong> ' + (notification.text_tokens.threads_count>1?'have':'has') + ' been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>';
					
					container.append(get_notification (notification, message));
					
					break;
				
				case "forum-thread-reply-owner":
					// "forum-thread-reply-owner":"<strong>' + notification.text_tokens.member_displayname + '</strong> replied to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> replied to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-owner.grouped":
					// "forum-thread-reply-owner.grouped":"<strong>' + notification.text_tokens.members_count + ' replies</strong> to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.members_count + ' replies</strong> to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-vote-owner":
					// "forum-thread-vote-owner":"<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					
					break;
					
				case "forum-thread-vote-owner.grouped":
					// "forum-thread-vote-owner.grouped":"<strong>' + notification.text_tokens.votes_count + ' votes</strong> for your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.votes_count + '</strong> replied to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply":
					// "forum-thread-reply":"<strong>' + notification.text_tokens.member_displayname + '</strong> replied in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> replied in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply.grouped":
					// "forum-thread-reply.grouped":"<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-personal":
					// "forum-thread-reply-personal":"<strong>' + notification.text_tokens.member_displayname + '</strong> replied to you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"

					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> replied to you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-personal.grouped":
					// "forum-thread-reply-personal.grouped":"<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-vote-personal":
					// "forum-thread-reply-vote-personal":"<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-vote-personal.grouped":
					// "forum-thread-reply-vote-personal.grouped":"<strong>' + notification.text_tokens.votes_count + ' votes</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.votes_count + ' votes</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-quote-personal":
					// "forum-thread-reply-quote-personal":"<strong>' + notification.text_tokens.member_displayname + '</strong> has quoted you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has quoted you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "community-update-rename":
					// "community-update-rename":"Your organization <strong>' + notification.text_tokens.old_name + '</strong> has been renamed to <strong>' + notification.text_tokens.new_name + '</strong>"
					
					message = 'Your organization <strong>' + notification.text_tokens.old_name + '</strong> has been renamed to <strong>' + notification.text_tokens.new_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-create":
					// "role-create":"<strong>' + notification.text_tokens.member_displayname + '</strong> has created a new <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has created a new <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-remove":
					// "role-remove":"<strong>' + notification.text_tokens.member_displayname + '</strong> has deleted the <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has deleted the <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-update-rename":
					// "role-update-rename":"<strong>' + notification.text_tokens.member_displayname + '</strong> has rename the <strong>' + notification.text_tokens.old_role_name + '</strong> role to <strong>' + notification.text_tokens.new_role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has rename the <strong>' + notification.text_tokens.old_role_name + '</strong> role to <strong>' + notification.text_tokens.new_role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-update-permissions":
					//"role-update-permissions":"<strong>' + notification.text_tokens.member_displayname + '</strong> has changed permissions for the role <strong>' + notification.text_tokens.role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has changed permissions for the role <strong>' + notification.text_tokens.role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "lobby-member-mention":
					// "lobby-member-mention":"<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.lobby_displayname + '</strong>: <em>' + notification.text_tokens.message + '</em>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.lobby_displayname + '</strong>: <em>' + notification.text_tokens.message + '</em>';
					
					container.append(get_notification (notification, message));
					
					break;
					
				case "private-lobby-member-mention":
					//	"private-lobby-member-mention":"<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in a private message: <em>' + notification.text_tokens.message + '</em>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in a private message: <em>' + notification.text_tokens.message + '</em>';
					
					container.append(get_notification (notification, message));
					break;
				
				case "forum-thread-member-mention":
					// "forum-thread-member-mention":"<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-erase":
					// "forum-thread-moderation-erase":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>"
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-moderation-erase":
					// "forum-thread-reply-moderation-erase":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your reply inside the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>"
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your reply inside the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-lock":
					// "forum-thread-moderation-lock":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>closed</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>"
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>closed</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-unlock":
					// "forum-thread-moderation-unlock":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>reopened</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>reopened</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
						
				case "forum-thread-moderation-pin":
					// "forum-thread-moderation-pin":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>pinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>pinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-unpin":
					// "forum-thread-moderation-unpin":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>unpinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>unpinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-flag":
					// "forum-thread-reply-flag":'Thread post by <strong>' + notification.text_tokens.author_displayname + '</strong> was flagged by <strong>' + notification.text_tokens.reporter_displayname + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>.\n\n<strong>Reason:</strong> <em>"' + notification.text_tokens.reason + '"</em>',"lobby-message-flag":'Lobby message by <strong>' + notification.text_tokens.author_displayname + '</strong> was flagged by <strong>' + notification.text_tokens.reporter_displayname + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>. \n\n<strong>Reason:</strong> <em>"' + notification.text_tokens.reason + '"</em>'
					
					message = 'Thread post by <strong>' + notification.text_tokens.author_displayname + '</strong> was flagged by <strong>' + notification.text_tokens.reporter_displayname + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>.\n\n<strong>Reason:</strong> <em>"' + notification.text_tokens.reason + '"</em>';
					
					container.append(get_notification (notification, message));
					break;
						
				case "guide-request-new":
					// "guide-request-new":"<strong>' + notification.text_tokens.member_displayname + '</strong> sent you a guiding request."
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> sent you a guiding request.';
					
					container.append(get_notification (notification, message));
					break;
					
				case "guide-request-declined":
					// "guide-request-declined":"<strong>' + notification.text_tokens.member_displayname + '</strong> declined your guiding request."
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> declined your guiding request.';
					
					container.append(get_notification (notification, message));
					break;
					
				case "guide-session-start":
					// "guide-session-start":"<strong>' + notification.text_tokens.member_displayname + '</strong> accepted your guiding request."
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> accepted your guiding request.';
					
					container.append(get_notification (notification, message));
					break;
						
				case "guide-session-terminate":
					// "guide-session-terminate":"Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended."
					
					message = 'Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended.';
					
					container.append(get_notification (notification, message));
					break;
					
				case "guide-session-endorsement":
					// "guide-session-endorsement":"Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended. Don't forget to endorse your Guide!"
					
					message = 'Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended. Don\'t forget to endorse your Guide!';
					
					container.append(get_notification (notification, message));
					break;
					
				default:
					break;
			}			
		});
		
		$('.toast').toast('show')
	}
}


function  CheckConnection(DoPreload, force, from, callback) {
	
	var hash = window.location.hash;
	
	$('nav a.navbar-brand > small > i.fa-spin').removeClass('d-none');
	
	$('.live_status').html('<i class="fas fa-spinner fa-pulse"></i> Checking...').addClass('btn-secondary').removeClass('btn-danger').attr('href', base_LIVE_Url + 'connect');
	
	// Collecting News
	chrome.runtime.sendMessage({
		type: 'CheckConnection',
		force: force,
		from: from,
	}, (result) => {
		connection_status = result;
		
		if (connection_status.live.connected === true)
		{
			update_connection('live_status', true);
			Rsi_LIVE_Token = connection_status.live.token;
			
			var data = connection_status.live.data;
			
			update_notification(data);
			
			handle = data.member.nickname;
			
			$('.navbar:eq(0) .avatar').attr('src', data.member.avatar).attr('alt', data.member.displayname);
			$('.navbar:eq(0) .displayname').text(data.member.displayname);
			$('.navbar:eq(0) a.nickname').attr('href', base_LIVE_Url + 'citizens/'+handle);
			$('.navbar:eq(0) a.nickname > span').text(handle);

			$('#organizations-li').removeClass('d-none');
			
			if (DoPreload === true || PreLoaded === false)
			{
				PreLoaded = true;
				pre_load_data(hash, () => {
					if (force)
					{						
						if (hash.startsWith("#")) var elem = $('nav.sidebar ul > li > a[href="' + hash + '"]');
						
						//  If hash doesn't exist
						if (typeof elem === "undefined")
						{
							if (data.nb_notification > 0)
							{
								// Open Spectrum
								elem = $('nav.sidebar ul > li > a:eq(1)');
							}								
							else 
							{
								// Open first element in the menu, eg "Comm-Link"
								elem = $('nav.sidebar ul > li > a:eq(0)');
							}
						}							
						
						if (typeof elem !== "undefined") LeftMenu_Click(elem);
					}
				});
			}
		}
		else update_connection('live_status', false);
		
		if (connection_status.ptu.connected === true)
		{
			update_connection('ptu_status', true);
			Rsi_PTU_Token = connection_status.ptu.token;
			
			// display the sync button
			$('#display_sync_button').removeClass('d-none');
		}
		else update_connection('ptu_status', false);
		
		$('nav a.navbar-brand > small > i.fa-spin').addClass('d-none');
		
		if (typeof callback != "undefined") callback(result);
	});
}


function update_connection(elem, connected) {
	
	$('nav a.navbar-brand i').addClass('d-none');
	
	if (connected) 
	{		
		if (elem == 'live_status')
		{
			// connected to RSI website
			$('#cnx_status').addClass('d-none');
			$('body').addClass('connected');
			
			$('main, nav, #app').removeClass('d-none');
			
		}
		else {
			// connected in PTU
			$('.ptu_status').addClass('d-none');
			$('.sync').removeClass('d-none');
		}
	}
	else {		
		if (elem == 'live_status') 
		{
			// not connected to RSI website
			$('#cnx_status').removeClass('d-none');
			$('body').removeClass('connected');
			$('nav, #app, .sync').addClass('d-none');
			
			$('.' + elem).html('Sign into RSI').removeClass('btn-secondary').addClass('btn-danger');
		}
		else{
			// not connected in PTU
			$('.ptu_status').removeClass('d-none');
			$('.sync').addClass('d-none');
		}
	}
}





function LeftMenu_Click(elem) {
	href = elem.attr('href');

	//elem.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	if (href.length > 1) {
		$('nav.sidebar ul > li > a').removeClass('active');
		elem.addClass('active');
		$('main .page').addClass('d-none');

		$(href).removeClass('d-none');

		switch (href) {
			case "#page_Comm_Link":
				LeftMenu_Click_Comm_Link(elem, href);
				break;

			case "#page_Spectrum":
				LeftMenu_Click_Spectrum(elem, href);
				break;

			case "#page_Ships":
				LeftMenu_Click_Ships(elem, href);
				break;

			case "#page_Contacts":
				LeftMenu_Click_Contacts(elem, href);
				break;

			case "#page_Organizations":
				LeftMenu_Click_Organizations(elem, href);
				break;

			case "#page_Roadmap":
				LeftMenu_Click_Roadmap(elem, href);
				break;

			case "#page_Telemetry":
				LeftMenu_Click_Telemetry(elem, href);
				break;
		}
	}
}






function timeSince(timeStamp) {
	timeStamp = new Date(timeStamp*1000);
	
	var now = new Date(),
		secondsPast = (now.getTime() - timeStamp) / 1000;
	if (secondsPast < 60) {
		number = parseInt(secondsPast)
		return number + ' sec ago';
	}
	if (secondsPast < 3600) {
		number = parseInt(secondsPast / 60)
		return number + ' min ago';
	}
	if (secondsPast <= 86400) {
		number = parseInt(secondsPast / 3600)
		return number + ' hour' + (number>1?'s':'') + ' ago';
	}
	if (secondsPast <= 604800) {
		number = parseInt(secondsPast / 86400)
		return number + ' day' + (number>1?'s':'') + ' ago';
	}
	else {
		day = timeStamp.getDate();
		month = timeStamp.toDateString().match(/ [a-zA-Z]*/)[0].replace(" ", "");
		year = timeStamp.getFullYear() == now.getFullYear() ? "" : " " + timeStamp.getFullYear();
		return "on " + day + " " + month + year;
	}
}

Array.prototype.sortAscOn = function(key){
    this.sort(function(a, b){
        if(a[key] < b[key]){
            return -1;
        }else if(a[key] > b[key]){
            return 1;
        }
        return 0;
    });
}
Array.prototype.sortDescOn = function(key){
    this.sort(function(a, b){
        if(a[key] > b[key]){
            return -1;
        }else if(a[key] < b[key]){
            return 1;
        }
        return 0;
    });
}


function capitalizeFirstLetter(string) {
	if (string != null) return string.charAt(0).toUpperCase() + string.slice(1);
	return "";
}

function delay(callback, ms) {
	var timer = 0;
	return () => {
		var context = this,
			args = arguments;
		clearTimeout(timer);
		timer = setTimeout( () => {
			callback.apply(context, args);
		}, ms || 0);
	};
}

function humanFileSize(bytes, si) {
	var thresh = si ? 1000 : 1024;
	if (Math.abs(bytes) < thresh) {
		return bytes + ' B';
	}
	var units = si ?
		['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] :
		['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
	var u = -1;
	do {
		bytes /= thresh;
		++u;
	} while (Math.abs(bytes) >= thresh && u < units.length - 1);
	return bytes.toFixed(1) + ' ' + units[u];
}

function numberWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

