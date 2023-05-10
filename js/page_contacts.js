var friendlist;
var friendrequests;
		
function LeftMenu_Click_Contacts(elem, href)
{
	if (Rsi_LIVE_Token === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		elem.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
		
		// Collecting Friends current user
		chrome.runtime.sendMessage({
			type: 'getFriends',
			LIVE: true,
			Token: Rsi_LIVE_Token,
		}, (FriendList) => {
			elem.find('.badge').html('');
			
			this_contacts_row = $(href + ' .content .my_contacts').find('.row');
			this_contacts_row.html('');
			
			if (FriendList.success == 1) {
				friendlist = FriendList.data.reverse();
				//friendlist.sortAscOn('displayname');

				elem.find('.badge').text($(friendlist).length);
				
				$(friendlist).each(function (id, friend) {
					friend.following = true;
					display_contact(this_contacts_row, id, friend);
				});
				
				sort_card('displayname', 'asc')

				$('#input_search_contacts').removeClass('d-none');

				//$('#contacts_search').val('');
				$('#contacts_search').keyup();
			}
			
			// Collecting FriendRequest of current user
			chrome.runtime.sendMessage({
				type: 'getFriendRequests',
				LIVE: true,
				Token: Rsi_LIVE_Token,
			}, (FriendRequests) => {
				this_contacts_row = $(href + ' .content .pending_contacts').find('.row');
				this_contacts_row.html('');
				
				$('button#pending_contacts span.nb_contacts').text('(0)');
				
				if (FriendRequests.success == 1) {
					friendrequests = FriendRequests.data;
					//friendlist.sortAscOn('displayname');
					
					$(friendrequests).each(function (id, friend) {
						display_contact(this_contacts_row, id, friend);
					});

					$('button#pending_contacts span.nb_contacts').text('(' + $(friendrequests).length + ')');
				}
			});
		});
	}
}

function display_contact(elem, id, friend)
{
	var friend_request = false;
	var requested = true;
	var already_requested = false;
	var already_friend = false;
	
	if (typeof friend.members != "undefined" && typeof friend.status != "undefined")
	{
		// Friend request
		friend_request = true;
		
		request_data = friend;
		friend = request_data.members[0];
		
		request_data.status_name = request_data.status;
		switch (request_data.status_name)
		{
			case "pending":
				// If request by current user, then it's a request you have done.
				if (request_data.requesting_member_id == connection_status.live.data.member.id)
				{
					requested = true;
					request_data.status_name = "Request sent";
				}
				else
				{
					requested = false;
					request_data.status_name = "Request received";
				}
				break;
			default:
				break;
		}
	}
	else
	{
		$(friendlist).each(function (id, this_friend) {
			if (this_friend.id == friend.id)
			{
				already_friend = true;
			}
		});
		
		$(friendrequests).each(function (id, this_friend_request) {
			if (this_friend_request.target_member_id == friend.id)
			{
				already_requested = true;
			}
		});
	}
	
	if (friend.avatar == null) friend.avatar = base_LIVECDN_Url + "static/images/account/avatar_default_big.jpg";
	
	var badges = '';
	
	$(friend.meta.badges).each(function (i, value) {
		if (! value.icon.startsWith("https")) value.icon = base_LIVE_Url + value.icon;
		badges = badges + ' <img src="' + sanitizeHTML(value.icon) + '" title="' + sanitizeHTML(value.name) + '">';
	});
	
	id = sanitizeHTML(id);
	friend.nickname = sanitizeHTML(friend.nickname);
	friend.displayname = sanitizeHTML(friend.displayname);
	friend.avatar = sanitizeHTML(friend.avatar);
	if (friend_request)
	{
		request_data.status_name = sanitizeHTML(request_data.status_name);
		request_data.id = sanitizeHTML(request_data.id);
	}
	
	elem.append('' +
		'<div class="col mb-4" data-date="' + id + '" data-handle="' + friend.nickname + '" data-displayname="' + friend.displayname + '">' +
			'<div class="card bg-' + (requested?'dark':'light') + '">' +
				'<div class="card-header p-1">' +
					'<div class="media-body">' +
						'<div class="displayname">'+
							'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + '</a>' + badges + (!friend_request ? '' : request_data.status_name) +
						'</div>' +
						'<div>' +
							'<small><span class="nickname text-secondary">' + friend.nickname + '</span></small>' +
						'</div>' +
					'</div>' +
				'</div>' +
				
					'<div class="card-body p-2">' +
						'<div class="media">' +
							'<img src="' + friend.avatar + '" class="align-self-start mr-3 rounded" alt="' + friend.displayname + '">' +
							'<div class="media-body align-self-center">' +
								( !friend_request ? 
									'<button type="button" class="btn btn-' + (friend.following ? 'dark' : (already_friend ? 'dark' : (already_requested ? 'info' : 'success'))) + ' btn-sm follow" data-member_id="' + friend.id + '" data-nickname="' + friend.nickname + '" data-action="' + (friend.following ? 'unfollow' : 'follow') + '"><i class="fas fa-user-' + (friend.following ? 'minus' : 'plus') + '"></i><span class="d-md-none d-lg-inline"> ' + (friend.following ? 'Unfriend' : (already_friend ? 'Already Friend' : (already_requested ? 'Request sent' : 'Send Friend Request'))) + '</span></button>'
								: 
									( requested ? 
										'<button type="button" class="btn btn-dark btn-sm cancel_friend_request" data-request_id="' + request_data.id + '">Cancel</button>'
									: 
										'<button type="button" class="btn btn-dark btn-sm accept_friend_request" data-request_id="' + request_data.id + '">Accept</button> <button type="button" class="btn btn-dark btn-sm decline_friend_request" data-request_id="' + request_data.id + '">Decline</button>'
									)
								) +
							'</div>' +
						'</div>' +
					'</div>' +
			'</div>' +
		'</div>' +
	'');
}

function sort_card(sort_by, sort_type)
{
	all_contacts_elem = $('.my_contacts > .row, .live_contacts > .row');
	
	all_contacts_elem.each((index_all_contacts, contact_content) => {
		var contacts = $(contact_content).find('div.col');
		if (contacts.length > 0)
		{
			var contact_array = [];
			contacts.each((index_contact, contact) => {
				var sort = $(contact).data(sort_by);
				if (typeof sort == "undefined") sort = '';
				
				var data = [];
				data['sort'] = sort.toString().toLowerCase();
				data['html'] = contact.outerHTML;
				contact_array.push(data);
			});
			
			switch (sort_type)
			{
				case 'asc':
					contact_array.sortAscOn('sort');
					break;
				case 'desc':
					contact_array.sortDescOn('sort');
					break;
				default:
					break;
			}
			
			$(contact_content).html('');
			$(contact_array).each((index_contact, contact) => {
				$(contact_content).append('' + contact.html + '');
			});
		}
	});
}

$(document).ready(function () {
	
	// Contact search	
	$(document).on('keyup', '#contacts_search', function () {
		var found_my_contacts;
		var found_contacts;
		
		
		var selectors = $('#page_Contacts button[id]');
		$(selectors).each(function (i, value) {
			$('.' + $(value).attr('id') + '').addClass('d-none');
		});
		
		var current_selector_id = $('#page_Contacts button[id].btn-success').attr('id');
		$('.' + current_selector_id + '').removeClass('d-none');
		
		
		var only_my_contacts = false;
		if (current_selector_id  == 'my_contacts') only_my_contacts = true;

		var search_input = $(this).val().trim().toLowerCase();
		
		var my_contacts = $('.my_contacts');
		var my_contacts_row = my_contacts.find('.row');
		var my_contacts_no_search = $(my_contacts).find('.alert');
		my_contacts_no_search.addClass('d-none');
		
		var live_contacts = $('.live_contacts');
		var live_row = live_contacts.find('.row');
		live_row.html('');
		var live_contacts_no_search = $(live_contacts).find('.alert');
		live_contacts_no_search.addClass('d-none');
		
		
		
		
		/////////////////////////////////
		// LOCAL SEARCH ON MY CONTACTS //
		/////////////////////////////////
		var my_contacts_div = my_contacts_row.children();
		
		my_contacts_div.attr("data-nb_found", 0).addClass('d-none');
		var keywords = search_input.split(' ');

		$(my_contacts_div).each(function (i, contact_div) {
			var nickname = $(contact_div).data('handle');
			if (nickname != 'null') nickname = nickname.toLowerCase();
			else nickname = '';

			var displayname = $(contact_div).data('displayname');
			if (displayname != 'null') displayname = displayname.toLowerCase();
			else displayname = '';

			$(keywords).each(function (index, keyword) {
				if (
					nickname.includes(keyword) ||
					displayname.includes(keyword)
				) {
					// keyword found
					nb_found = parseInt($(contact_div).attr("data-nb_found")) + 1;

					$(contact_div).attr("data-nb_found", nb_found);
				}

			});
		});

		found_my_contacts = my_contacts.find('div[data-nb_found="' + keywords.length + '"]').removeClass('d-none');
		
		$('button#my_contacts span.nb_contacts').text('(' + $(found_my_contacts).length + ')');
		if ($(found_my_contacts).length > 1) $('button#my_contacts span.plurial').text('s');
		else if ($(found_my_contacts).length == 0)
		{
			my_contacts_no_search.removeClass('d-none alert-warning').addClass('alert-danger').html('No result.');
		}

		/////////////////
		// LIVE SEARCH //
		/////////////////
		if (search_input.length > 0) {
			live_row.html('<div class="text-center text-secondary mt-4"><i class="fas fa-spinner fa-spin fa-5x"></i></center>');
			chrome.runtime.sendMessage({
				type: 'SearchContact',
				LIVE: true,
				Token: Rsi_LIVE_Token,
				Query: search_input,
			}, function (result) {
				live_row.html('');
				if (result.success == 1) {
					found_contacts = result.data.members;

					$(found_contacts).each(function (id, friend) {
						display_contact(live_row, id, friend);
					});
					
					$('button#live_contacts span.nb_contacts').text('(' + $(found_contacts).length + ')');
					if ($(found_contacts).length > 1) $('button#live_contacts span.plurial').text('s');
					else if ($(found_contacts).length < 1)
					{
						live_row.html('');
						if (!only_my_contacts) live_contacts_no_search.removeClass('d-none alert-warning').addClass('alert-danger').html('No result.');
					}
					
					if (only_my_contacts && $(found_my_contacts).length == 0 && $(found_contacts).length > 1) $('button#live_contacts').click();
				}
				else
				{
					live_row.html('');
					live_contacts_no_search.removeClass('d-none alert-warning').addClass('alert-danger').html('Unexpected Error.');
				}
			});
		}
		else
		{
			live_row.html('');
			live_contacts_no_search.removeClass('d-none alert-danger').addClass('alert-warning').html('You need to enter 1 character minimum to enable live search.');
			
			if (search_input.length == 0) $('button#live_contacts span.nb_contacts').text('(0)');
		}
	});

	// Follow / unfollow friend
	$(document).on('click', 'button.follow', function () {
		var button = $(this);
		
		button.html('<i class="fas fa-sync fa-spin"></i>');

		var member_id = button.data('member_id');
		var nickname = button.data('nickname');
		var action = button.data('action');

		var add = true;
		if (action == "unfollow") add = false;

		if (typeof (member_id) != "undefined" &&  member_id > 0) {
			chrome.runtime.sendMessage({
				type: 'addtoFriendList',
				LIVE: true,
				Token: Rsi_LIVE_Token,
				member_id: member_id,
				Add: add,
			}, function (result) {
				$('a.nav-link[href="#page_Contacts"]').click();
			});
		}
		else if(nickname.length > 0) {
			chrome.runtime.sendMessage({
				type: 'SearchContact',
				LIVE: true,
				Token: Rsi_LIVE_Token,
				Query: nickname,
			}, function (result) {
				var friend_found = false;
				$(result.data.members).each(function (i, searched_member) {
					if (searched_member.nickname == nickname)
					{
						friend_found = searched_member;
					}
				});
				
				if (friend_found !== false)
				{
					// we try to add that friend
					chrome.runtime.sendMessage({
						type: 'addtoFriendList',
						LIVE: true,
						Token: Rsi_LIVE_Token,
						member_id: friend_found.id,
						Add: add,
					}, function (result) {
						
						button.removeClass('btn-success follow').addClass('btn-info').html('Request sent');
					});
				}
				else button.removeClass('btn-success follow').addClass('btn-danger').html('Error');
			});
		}

	});
	
	// Cancel Friend Request
	$(document).on('click', 'button.cancel_friend_request', function () {
		var button = $(this);
		button.html('<i class="fas fa-sync fa-spin"></i>');
		
		chrome.runtime.sendMessage({
			type: 'CancelFriendRequest',
			Token: Rsi_LIVE_Token,
			request_id: button.data('request_id'),
		}, (CancelFriendRequest) => {
			$('a.nav-link[href="#page_Contacts"]').click();
		});
	});
	
	// Accept Friend Request
	$(document).on('click', 'button.accept_friend_request', function () {
		var button = $(this);
		button.html('<i class="fas fa-sync fa-spin"></i>');
		
		chrome.runtime.sendMessage({
			type: 'AcceptFriendRequest',
			Token: Rsi_LIVE_Token,
			request_id: button.data('request_id'),
		}, (AcceptFriendRequest) => {
			$('a.nav-link[href="#page_Contacts"]').click();
		});
	});
	
	// Decline Friend Request
	$(document).on('click', 'button.decline_friend_request', function () {
		var button = $(this);
		button.html('<i class="fas fa-sync fa-spin"></i>');
		
		chrome.runtime.sendMessage({
			type: 'DeclineFriendRequest',
			Token: Rsi_LIVE_Token,
			request_id: button.data('request_id'),
		}, (DeclineFriendRequest) => {			
			$('a.nav-link[href="#page_Contacts"]').click();
		});
	});
	

	// Click on button (to filter the search only for the contact you owned or from Citizen search)
	$(document).on('click', '#page_Contacts .page-content button.btn:not(".contacts_sort")', function () {
		$('#page_Contacts .page-content button.btn:not(".contacts_sort")').attr('class', 'btn btn-secondary');
		$(this).toggleClass('btn-secondary').toggleClass('btn-success');
		
		$(this).parent().parent().nextAll().addClass('d-none');
		$('.'+$(this).attr('id')).removeClass('d-none');
	});
	
	// Click to sort contacts by type
	$(document).on('click', '#page_Contacts button.contacts_sort', function () {
		$('button.contacts_sort').removeClass('active').addClass('btn-secondary').removeClass('btn-primary');
		$(this).addClass('active').removeClass('btn-secondary').addClass('btn-primary');
		
		var sort_by =$(this).data('sort_by');
		var sort_type =$(this).data('sort_type');
		
		sort_card(sort_by, sort_type)
	});
	
	

	// SUMMARY CLICK BEHAVIOR
	$(document).on('click', '#summary ul > li', function () {
		contact_type = $(this).data('type');

		if ($(this).hasClass('active')) {
			$(this).removeClass('active')
			$('#log table tbody tr').removeClass('d-none');
		} else {
			$('#summary ul > li').removeClass('active');
			$(this).addClass('active');

			$('#log table tbody tr').addClass('d-none');
			$('#log table tbody tr.' + contact_type).removeClass('d-none');
		}
	});


	// SYNC LIVE -> PTU
	$(document).on('click', 'button#btn_sync_contact', function () {
		$('#log, #summary').addClass('d-none');
		$('#log table tbody').html('');
		$('#btn_sync_contact > i.fa-sync').addClass('fa-spin');
		$('#btn_sync_contact > span:eq(0)').addClass('d-none');
		$('#btn_sync_contact > span:eq(1)').removeClass('d-none');

		// GET LIVE friend list
		chrome.runtime.sendMessage({
			type: 'getFriends',
			LIVE: true,
			Token: Rsi_LIVE_Token,
		}, function (result) {
			var LIVE_friend_list = result.data;

			// GET PTU friend list
			chrome.runtime.sendMessage({
				type: 'getFriends',
				LIVE: false,
				Token: Rsi_PTU_Token,
			}, function (result) {
				var PTU_friend_list = result.data;
				
				// GET PTU friend list
				chrome.runtime.sendMessage({
					type: 'getFriendRequests',
					LIVE: false,
					Token: Rsi_PTU_Token,
				}, function (result) {
					var PTU_FriendRequests = result.data;
					
					$('#contacts_added').text(0);
					$('#contacts_no_ptu').text(0);
					$('#contacts_pending').text(0);
					$('#contacts_existing').text(0);

					var contact_type = '';
					var contact_status = '';
					var contact_status_color = '';

					$(LIVE_friend_list).each(function (i, friend) {
						if (typeof friend.avatar == "undefined" || friend.avatar == null) friend.avatar = '../img/default_avatar.jpg';
						
						if (PTU_friend_list.some(e => e.nickname == friend.nickname))
						{
							// Friend already added
							contact_type = 'contacts_added';
							contact_status = 'Already Friend'
							contact_status_color = 'success';
							
							$('#contacts_added').text(parseInt($('#contacts_added').text()) + 1);
							
							add_line_sync_contact (friend, contact_type, contact_status, contact_status_color)
						}
						else if (PTU_FriendRequests.some(e => e.members[0].nickname == friend.nickname))
						{
							// Friend already pending
							contact_type = 'contacts_pending';
							contact_status = 'Pending'
							contact_status_color = 'info';
							
							$('#contacts_pending').text(parseInt($('#contacts_pending').text()) + 1);
							
							add_line_sync_contact (friend, contact_type, contact_status, contact_status_color)
						}
						else
						{
							// Friend can't be found.
							
							chrome.runtime.sendMessage({
								type: 'SearchContact',
								LIVE: false,
								Token: Rsi_PTU_Token,
								Query: friend.nickname,
							}, function (result) {
								var friend_found = false;
								$(result.data.members).each(function (i, searched_member) {
									if (searched_member.nickname == friend.nickname)
									{
										friend_found = searched_member;
									}
								});
								
								if (friend_found !== false)
								{
									// we try to add that friend
									chrome.runtime.sendMessage({
										type: 'addtoFriendList',
										LIVE: false,
										Token: Rsi_PTU_Token,
										member_id: friend_found.id,
										Add: true,
									}, function (result) {
										
										if (result.success) {
											contact_type = 'contacts_pending';
											contact_status = 'Pending'
											contact_status_color = 'info';
											
											$('#contacts_pending').text(parseInt($('#contacts_pending').text()) + 1);
											
											add_line_sync_contact (friend, contact_type, contact_status, contact_status_color)
										}
									});
								}
								else
								{
									contact_type = 'contacts_no_ptu';
									contact_status = 'No PTU Account'
									contact_status_color = 'danger';
									
									$('#contacts_no_ptu').text(parseInt($('#contacts_no_ptu').text()) + 1);
									
									add_line_sync_contact (friend, contact_type, contact_status, contact_status_color)
								}
								
								$('#log, #summary').removeClass('d-none');
								$('#btn_sync_contact > i.fa-sync').removeClass('fa-spin');
								$('#btn_sync_contact > span:eq(0)').removeClass('d-none');
								$('#btn_sync_contact > span:eq(1)').addClass('d-none');
							});
						}
					});
				});
			});
		});
	});
});


function add_line_sync_contact (friend, contact_type, contact_status, contact_status_color)
{
	friend.avatar = sanitizeHTML(friend.avatar);
	friend.displayname = sanitizeHTML(friend.displayname);
	friend.nickname = sanitizeHTML(friend.nickname);
	
	$('#log table tbody').append('' +
		'<tr class="' + contact_type + '">' +
			'<td class="align-middle">' +
				'<img src="' + friend.avatar + '" alt="' + friend.displayname + '" class="img-responsive rounded friend_logo">' +
			'</td>' +
			'<td class="align-middle">' +
				'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + ' <small><i class="fas fa-external-link"></i></small></a>' +
			'</td>' +
			'<td class="align-middle text-' + contact_status_color + '">' +
				'<i>' + contact_status + '</i>' +
			'</td>' +
		'</tr>' +
	'');
}