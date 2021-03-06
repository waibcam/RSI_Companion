// open appropriate page based on url hash
var max_news_page = 1; // 10 news per page.
var nb_Spectrum_notification = 0;

const base_LIVE_Url = "https://robertsspaceindustries.com/";
const base_PTU_Url = "https://ptu.cloudimperiumgames.com/";

var connection_status = false;
var user_data = false;

var handle = false;

var Rsi_LIVE_Token = false;
var Rsi_PTU_Token = false;

var PreLoaded = false;

var service_status = false;

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
			case "UpdateSpectrumNotifications":
				update_notification(request.data);
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
	
	chrome.runtime.sendMessage({
		type: 'getReferrals',
		Token: Rsi_LIVE_Token,
	}, function(Referrals){
		if (Referrals.success == 1)
		{
			Referrals.data.recruits = sanitizeHTML(Referrals.data.recruits);
			Referrals.data.end = sanitizeHTML(Referrals.data.end);
			Referrals.data.prospects = sanitizeHTML(Referrals.data.prospects);
			
			$('#referal').parent().removeClass('d-none');
			$('#referal').html('<a href="https://robertsspaceindustries.com/account/referral-program" target="_blank">' + Referrals.data.recruits + '/' + Referrals.data.end + ' (' + Referrals.data.prospects + ' prospect' + (Referrals.data.prospects > 1?'s':'') + ')</a>');
		}
	});
	
	
	news_li_a = $('a.nav-link[href="#page_Comm_Link"]');
	news_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	// Collecting Comm-Links (News)
	for (var page = 1; page <= max_news_page; page++) {
		chrome.runtime.sendMessage({
			type: 'getNews',
			Token: Rsi_LIVE_Token,
			page: page,
		}, (news_result) => {
			if (news_result.success == 1)
			{
				if (typeof news_result != "undefined")
				{
					News[news_result.page] = news_result;
				}
				
				if (news_result.page == max_news_page)
				{
					news_li_a.find('.badge').text(max_news_page*10);
					if (hash == "" || hash == "#page_Comm_Link") callback();

					news_li_a.parent().removeClass('d-none');
				}
			}
		});
	}
	
	
	if (hash == "#page_Spectrum") callback();
	
	// Check if ShipList cache already done.
	chrome.runtime.sendMessage({
		type: 'getShipListCachedSince',
	}, function(ShipListCachedSince){
		if (ShipListCachedSince.success == 1) refresh_ShipList_data("#page_Ships", false);
		else refresh_ShipList_data("#page_Ships", true);
		
		// Check if BB cache already done.
		chrome.runtime.sendMessage({
			type: 'getBuyBackCachedSince',
		}, function(BuyBackCachedSince){
			if (BuyBackCachedSince.success == 1) refresh_BB_data("#page_BuyBack", false);
			else refresh_BB_data("#page_BuyBack", true);
		});
	});
	
	
	
	
	
	contacts_li_a = $('a.nav-link[href="#page_Contacts"]');
	contacts_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	// Collecting Friend List
	chrome.runtime.sendMessage({
		type: 'getFriends',
		LIVE: true,
		Token: Rsi_LIVE_Token,
	}, (FriendList) => {
		if (FriendList.success == 1)
		{
			if (hash == "#page_Contacts") callback();
			contacts_li_a.find('.badge').html(sanitizeHTML(FriendList.data.length));
		}
		else contacts_li_a.parent().addClass('d-none');
	});
	
	
	organizations_li_a = $('a.nav-link[href="#page_Organizations"]');
	organizations_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	// Collecting Organization of current user
	chrome.runtime.sendMessage({
		type: 'getOrganizations',
	}, (Organizations) => {
		if (Organizations.success == 1)
		{
			if (hash == "#page_Organizations") callback();
			organizations_li_a.find('.badge').html(sanitizeHTML(Organizations.organizations.length));
		}
		else organizations_li_a.parent().addClass('d-none');
	});
	
	
	roadmap_li_a = $('a.nav-link[href="#page_Roadmap"]');
	roadmap_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	// Collecting Roadmap information
	chrome.runtime.sendMessage({
		type: 'getBoards',
	}, (Boards) => {
		
		if (Boards.success == 1)
		{
			if (hash == "#page_Roadmap") callback();
			roadmap_li_a.find('.badge').html(sanitizeHTML(Boards.data.boards.length));
		}
		else roadmap_li_a.parent().addClass('d-none');
	});
	
	
	releasenotes_li_a = $('a.nav-link[href="#page_ReleaseNotes"]');
	releasenotes_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	// Collecting RSI Companion Release Notes
	chrome.runtime.sendMessage({
		type: 'getReleaseNotes',
	}, (ReleaseNotes) => {
		if (ReleaseNotes.success == 1)
		{
			if (hash == "#page_ReleaseNotes") callback();
			
			var nb_release = 0;
			$(ReleaseNotes.data.releases).each((index, release) => {
				if (release.date !== false) nb_release++;
			});
			releasenotes_li_a.find('.badge').html(sanitizeHTML(nb_release));
		}
		else releasenotes_li_a.parent().addClass('d-none');
	});
	
	/*
	telemetry_li_a = $('a.nav-link[href="#page_Telemetry"]');
	telemetry_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	// Get Telemetry information
	chrome.runtime.sendMessage({
		type: 'getTelemetry',
		LIVE_Token: Rsi_LIVE_Token,
	}, (Telemetry) => {
		if (Telemetry.success == 1 && Telemetry.data.length > 0)
		{
			if (hash == "#page_Telemetry") callback();
		}
		else telemetry_li_a.parent().addClass('d-none');
	});
	*/
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
	
	debug_needed = true;
	
	link_url = base_LIVE_Url+'spectrum';
	$(link_path).each(function(index, value){
		switch (value)
		{
			case "community":
				link_url += '/community/' + notification.link_tokens.community_slug;
				debug_needed = false;
				break;
			case "channel":
				link_url += '/forum/' + notification.link_tokens.channel_id;
				debug_needed = false;
				break;
			case "thread":
				link_url += '/thread/' + notification.link_tokens.thread_slug;
				debug_needed = false;
				break;
			case "reply":
				link_url += '/' + notification.link_tokens.reply_id;
				debug_needed = false;
				break;
			case "lobby":
				link_url += '/lobby/' + notification.link_tokens.lobby_id;
				debug_needed = false;
				break;
			case "private":
			case "messages":
				link_url += '/messages/member/' + notification.link_tokens.member_id;
				debug_needed = false;
				break;
			case "friend":
				link_url = '#page_Contacts';
				debug_needed = false;
				break;
			default:
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
				'<a class="notifications-item" href="' + link_url + '"' + (!link_url.startsWith("#") ? ' target="_blank"' : '') + ' data-notification_id="' + notification.id + '">' + message + '</a>' +
			'</div>' +
		'</li>' +
	'';
	
}

function update_notification(data)
{
	elem = "#page_Spectrum";
	
	if (typeof data.total_notification != "undefined")
	{
		if (data.total_notification > 0)
		{
			setBadge(data.total_notification);
			$('a.nav-link[href="' + elem + '"]').find('.badge').html(sanitizeHTML(data.total_notification));
		}
		else
		{
			setBadge("0");
			$('a.nav-link[href="' + elem + '"]').find('.badge').html('');
		}
	}
	
	if (typeof data.notifications != "undefined")
	{
		var notifications = data.notifications;
		var nb_Spectrum_notification = parseInt(data.nb_Spectrum_notification)
		
		notifications.sortDescOn("time");
		
		$(elem).find('.content .notification .card-title > span').text('(' + nb_Spectrum_notification + '/' + notifications.length + ')');
		
		var container = $(elem).find('.content .notification ul.list-unstyled');
		container.html('');
		
		$(notifications).each(function (index, notification){
			
			if (notification.grouped) notification.type = notification.type + '.grouped';
			
			switch (notification.type)
			{
				case "friend-new-request":
					notification.text_tokens.displayname = sanitizeHTML(notification.text_tokens.displayname);
					notification.text_tokens.plaintext = sanitizeHTML(notification.text_tokens.plaintext);
					
					message = 'New friend request from <strong>' + notification.text_tokens.displayname + '</strong> is <em>"' + notification.text_tokens.plaintext + '"</em>';
					
					container.append(get_notification (notification, message));
					break;
				
				case "private-new-message":
					notification.text_tokens.displayname = sanitizeHTML(notification.text_tokens.displayname);
					notification.text_tokens.plaintext = sanitizeHTML(notification.text_tokens.plaintext);
					message = 'New Message from <strong>' + notification.text_tokens.displayname + '</strong>:<br /><em>"' + notification.text_tokens.plaintext + '"</em>';
					
					container.append(get_notification (notification, message));
					break;
				
				case "forum-channel-new-thread":
					// "forum-channel-new-thread" => "New thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> has been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>"
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					notification.text_tokens.forum_channel_name = sanitizeHTML(notification.text_tokens.forum_channel_name);

					message = 'New thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> has been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>';
					
					container.append(get_notification (notification, message));
					
				break;
					
				case "forum-channel-new-thread.grouped":
					// "forum-channel-new-thread.grouped":"<strong>' + notification.text_tokens.threads_count + ' new threads</strong> have been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>"
					notification.text_tokens.threads_count = sanitizeHTML(notification.text_tokens.threads_count);
					notification.text_tokens.forum_channel_name = sanitizeHTML(notification.text_tokens.forum_channel_name);

					message = '<strong>' + notification.text_tokens.threads_count + ' new thread' + (notification.text_tokens.threads_count>1?'s':'') + '</strong> ' + (notification.text_tokens.threads_count>1?'have':'has') + ' been created in channel <strong>' + notification.text_tokens.forum_channel_name + '</strong>';
					
					container.append(get_notification (notification, message));
					
					break;
				
				case "forum-thread-reply-owner":
					// "forum-thread-reply-owner":"<strong>' + notification.text_tokens.member_displayname + '</strong> replied to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> replied to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-owner.grouped":
					// "forum-thread-reply-owner.grouped":"<strong>' + notification.text_tokens.members_count + ' replies</strong> to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.members_count = sanitizeHTML(notification.text_tokens.members_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.members_count + ' replies</strong> to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-vote-owner":
					// "forum-thread-vote-owner":"<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.votes_count = sanitizeHTML(notification.text_tokens.votes_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					
					break;
					
				case "forum-thread-vote-owner.grouped":
					// "forum-thread-vote-owner.grouped":"<strong>' + notification.text_tokens.votes_count + ' votes</strong> for your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.votes_count = sanitizeHTML(notification.text_tokens.votes_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.votes_count + '</strong> replied to your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply":
					// "forum-thread-reply":"<strong>' + notification.text_tokens.member_displayname + '</strong> replied in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> replied in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply.grouped":
					// "forum-thread-reply.grouped":"<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.members_count = sanitizeHTML(notification.text_tokens.members_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-personal":
					// "forum-thread-reply-personal":"<strong>' + notification.text_tokens.member_displayname + '</strong> replied to you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);

					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> replied to you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-personal.grouped":
					// "forum-thread-reply-personal.grouped":"<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.members_count = sanitizeHTML(notification.text_tokens.members_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.members_count + ' new replies</strong> in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-vote-personal":
					// "forum-thread-reply-vote-personal":"<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.votes_count = sanitizeHTML(notification.text_tokens.votes_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.votes_count + ' new vote</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-vote-personal.grouped":
					// "forum-thread-reply-vote-personal.grouped":"<strong>' + notification.text_tokens.votes_count + ' votes</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.votes_count = sanitizeHTML(notification.text_tokens.votes_count);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.votes_count + ' votes</strong> for your reply in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-quote-personal":
					// "forum-thread-reply-quote-personal":"<strong>' + notification.text_tokens.member_displayname + '</strong> has quoted you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has quoted you in the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "community-update-rename":
					// "community-update-rename":"Your organization <strong>' + notification.text_tokens.old_name + '</strong> has been renamed to <strong>' + notification.text_tokens.new_name + '</strong>"
					notification.text_tokens.old_name = sanitizeHTML(notification.text_tokens.old_name);
					notification.text_tokens.new_name = sanitizeHTML(notification.text_tokens.new_name);
					
					message = 'Your organization <strong>' + notification.text_tokens.old_name + '</strong> has been renamed to <strong>' + notification.text_tokens.new_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-create":
					// "role-create":"<strong>' + notification.text_tokens.member_displayname + '</strong> has created a new <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.community_name = sanitizeHTML(notification.text_tokens.community_name);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has created a new <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-remove":
					// "role-remove":"<strong>' + notification.text_tokens.member_displayname + '</strong> has deleted the <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.community_name = sanitizeHTML(notification.text_tokens.community_name);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has deleted the <strong>' + notification.text_tokens.role_name + '</strong> role in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-update-rename":
					// "role-update-rename":"<strong>' + notification.text_tokens.member_displayname + '</strong> has rename the <strong>' + notification.text_tokens.old_role_name + '</strong> role to <strong>' + notification.text_tokens.new_role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.old_role_name = sanitizeHTML(notification.text_tokens.old_role_name);
					notification.text_tokens.new_role_name = sanitizeHTML(notification.text_tokens.new_role_name);
					notification.text_tokens.community_name = sanitizeHTML(notification.text_tokens.community_name);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has rename the <strong>' + notification.text_tokens.old_role_name + '</strong> role to <strong>' + notification.text_tokens.new_role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "role-update-permissions":
					//"role-update-permissions":"<strong>' + notification.text_tokens.member_displayname + '</strong> has changed permissions for the role <strong>' + notification.text_tokens.role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.role_name = sanitizeHTML(notification.text_tokens.role_name);
					notification.text_tokens.community_name = sanitizeHTML(notification.text_tokens.community_name);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> has changed permissions for the role <strong>' + notification.text_tokens.role_name + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "lobby-member-mention":
					// "lobby-member-mention":"<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.lobby_displayname + '</strong>: <em>' + notification.text_tokens.message + '</em>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.lobby_displayname = sanitizeHTML(notification.text_tokens.lobby_displayname);
					notification.text_tokens.message = sanitizeHTML(notification.text_tokens.message);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.lobby_displayname + '</strong>: <em>' + notification.text_tokens.message + '</em>';
					
					container.append(get_notification (notification, message));
					
					break;
					
				case "private-lobby-member-mention":
					//	"private-lobby-member-mention":"<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in a private message: <em>' + notification.text_tokens.message + '</em>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.message = sanitizeHTML(notification.text_tokens.message);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in a private message: <em>' + notification.text_tokens.message + '</em>';
					
					container.append(get_notification (notification, message));
					break;
				
				case "forum-thread-member-mention":
					// "forum-thread-member-mention":"<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> mentioned you in <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-erase":
					// "forum-thread-moderation-erase":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>"
					notification.text_tokens.moderator_member_displayname = sanitizeHTML(notification.text_tokens.moderator_member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-moderation-erase":
					// "forum-thread-reply-moderation-erase":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your reply inside the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>"
					notification.text_tokens.moderator_member_displayname = sanitizeHTML(notification.text_tokens.moderator_member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					notification.text_tokens.moderator_reason = sanitizeHTML(notification.text_tokens.moderator_reason);
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>deleted</strong> your reply inside the thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-lock":
					// "forum-thread-moderation-lock":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>closed</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>"
					notification.text_tokens.moderator_member_displayname = sanitizeHTML(notification.text_tokens.moderator_member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					notification.text_tokens.moderator_reason = sanitizeHTML(notification.text_tokens.moderator_reason);
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>closed</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong> for the following reason: <strong>' + notification.text_tokens.moderator_reason + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-unlock":
					// "forum-thread-moderation-unlock":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>reopened</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.moderator_member_displayname = sanitizeHTML(notification.text_tokens.moderator_member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>reopened</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
						
				case "forum-thread-moderation-pin":
					// "forum-thread-moderation-pin":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>pinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.moderator_member_displayname = sanitizeHTML(notification.text_tokens.moderator_member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>pinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-moderation-unpin":
					// "forum-thread-moderation-unpin":"Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>unpinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>"
					notification.text_tokens.moderator_member_displayname = sanitizeHTML(notification.text_tokens.moderator_member_displayname);
					notification.text_tokens.forum_thread_subject = sanitizeHTML(notification.text_tokens.forum_thread_subject);
					
					message = 'Moderator <strong>' + notification.text_tokens.moderator_member_displayname + '</strong> has <strong>unpinned</strong> your thread <strong>' + notification.text_tokens.forum_thread_subject + '</strong>';
					
					container.append(get_notification (notification, message));
					break;
					
				case "forum-thread-reply-flag":
					// "forum-thread-reply-flag":'Thread post by <strong>' + notification.text_tokens.author_displayname + '</strong> was flagged by <strong>' + notification.text_tokens.reporter_displayname + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>.\n\n<strong>Reason:</strong> <em>"' + notification.text_tokens.reason + '"</em>',"lobby-message-flag":'Lobby message by <strong>' + notification.text_tokens.author_displayname + '</strong> was flagged by <strong>' + notification.text_tokens.reporter_displayname + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>. \n\n<strong>Reason:</strong> <em>"' + notification.text_tokens.reason + '"</em>'
					notification.text_tokens.author_displayname = sanitizeHTML(notification.text_tokens.author_displayname);
					notification.text_tokens.reporter_displayname = sanitizeHTML(notification.text_tokens.reporter_displayname);
					notification.text_tokens.community_name = sanitizeHTML(notification.text_tokens.community_name);
					notification.text_tokens.reason = sanitizeHTML(notification.text_tokens.reason);
					
					message = 'Thread post by <strong>' + notification.text_tokens.author_displayname + '</strong> was flagged by <strong>' + notification.text_tokens.reporter_displayname + '</strong> in the organization <strong>' + notification.text_tokens.community_name + '</strong>.\n\n<strong>Reason:</strong> <em>"' + notification.text_tokens.reason + '"</em>';
					
					container.append(get_notification (notification, message));
					break;
						
				case "guide-request-new":
					// "guide-request-new":"<strong>' + notification.text_tokens.member_displayname + '</strong> sent you a guiding request."
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> sent you a guiding request.';
					
					container.append(get_notification (notification, message));
					break;
					
				case "guide-request-declined":
					// "guide-request-declined":"<strong>' + notification.text_tokens.member_displayname + '</strong> declined your guiding request."
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> declined your guiding request.';
					
					container.append(get_notification (notification, message));
					break;
					
				case "guide-session-start":
					// "guide-session-start":"<strong>' + notification.text_tokens.member_displayname + '</strong> accepted your guiding request."
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					
					message = '<strong>' + notification.text_tokens.member_displayname + '</strong> accepted your guiding request.';
					
					container.append(get_notification (notification, message));
					break;
						
				case "guide-session-terminate":
					// "guide-session-terminate":"Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended."
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					
					message = 'Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended.';
					
					container.append(get_notification (notification, message));
					break;
					
				case "guide-session-endorsement":
					// "guide-session-endorsement":"Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended. Don't forget to endorse your Guide!"
					notification.text_tokens.member_displayname = sanitizeHTML(notification.text_tokens.member_displayname);
					
					message = 'Your guiding session with <strong>' + notification.text_tokens.member_displayname + '</strong> has now ended. Don\'t forget to endorse your Guide!';
					
					container.append(get_notification (notification, message));
					break;
					
				default:
					break;
			}			
		});
		
		$( "#page_Spectrum img" ).on('error', function(e) {
			//console.log( e );
			$(this).attr( "src", "../img/default_avatar.jpg" )
			return true;
		});
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
			
			service_status = data.service_status;
			$('#service_status').html('');
			$(service_status).each((index, status) => {
				switch (status.name)
				{
					case 'platform':
						status.name = 'Platform';
						break;
					case 'pu':
						status.name = 'Persistent Universe';
						break;
					case 'ea':
						status.name = 'Electronic Access';
						break;
					default:
						break;
				}
				
				status.icon = '';
				
				switch (status.status)
				{
					case 'operational':
						status.icon = '<i class="fas text-success fa-check-circle"></i>';
						break;
					default:
						status.icon = '<i class="fas text-warning fa-exclamation-triangle"></i>';
						break;
				}
				
				status.status = sanitizeHTML(status.status);
				status.name = sanitizeHTML(status.name);
				
				$('#service_status').append('<a href="https://status.robertsspaceindustries.com/" target="_blank"><span data-toggle="popover" data-placement="bottom" data-trigger="hover" data-content="' + status.status + '" data-original-title="" title="">' + status.name + ': <strong class="mr-3">' + status.icon + '</strong></span></a>');
				
				$('[data-toggle="popover"]').popover({
					template: '<div class="popover" role="tooltip"><div class="arrow"></div><h3 class="popover-header"></h3><div class="popover-body"></div></div>'
				});
			});
			
			update_notification(data);
			
			handle = data.member.nickname;
			
			$('div.user_info img.avatar').attr('src', data.member.avatar).attr('alt', data.member.displayname);
			$('div.user_info div.displayname').text(data.member.displayname);
			$('div.user_info a.nickname').attr('href', base_LIVE_Url + 'citizens/'+handle);
			$('div.user_info a.nickname span.handle').text(handle);

			$('#organizations-li').removeClass('d-none');
			
			if (DoPreload === true || PreLoaded === false)
			{
				PreLoaded = true;
				pre_load_data(hash, () => {
					if (force)
					{
						if (hash.startsWith("#")) var elem = $('nav.sidebar ul > li > a[href="' + hash + '"]');
						
						//  If hash doesn't exist
						if (typeof elem == "undefined")
						{
							if (data.nb_Spectrum_notification > 0)
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
	if (typeof href != "undefined" && href.length > 1) {
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
			
			case "#page_BuyBack":
				LeftMenu_Click_BuyBack(elem, href);
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
				
			case "#page_ReleaseNotes":
				LeftMenu_Click_ReleaseNotes(elem, href);
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

var sanitizeHTML = function (str) {
	var temp = document.createElement('div');
	temp.textContent = str;
	return temp.innerHTML;
};
