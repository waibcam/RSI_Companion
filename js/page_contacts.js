function LeftMenu_Click_Contacts(elem, href)
{
	if (Rsi_LIVE_Token === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		var my_contacts = $(href + ' .content .my_contacts');
		
		// Collecting Organization of current user
		chrome.runtime.sendMessage({
			type: 'getFriendList',
			LIVE: true,
			Token: Rsi_LIVE_Token,
		}, (FriendList) => {
			my_contacts_row = my_contacts.find('.row');
			my_contacts_row.html('');
			
			if (FriendList.success == 1) {
				var friendlist = FriendList.data.reverse();
				//friendlist.sortAscOn('displayname');

				elem.find('.badge').text($(friendlist).length);
				
				$(friendlist).each(function (id, friend) {
					friend.following = true;
					append_contact(my_contacts_row, id, friend);
				});

				$('#input_search_contacts').removeClass('d-none');

				$('#contacts_search').val('');
				$('#contacts_search').keyup();
			}
		});
	}
}

function append_contact(elem, id, friend)
{
	elem.append('' +
		'<div class="col mb-4" data-date="' + id + '" data-handle="' + friend.nickname + '" data-displayname="' + friend.displayname + '">' +
			'<div class="card bg-dark">' +
				'<div class="card-header p-1">' +
					'<div class="media-body">' +
						'<div class="displayname">'+
							'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + '</a>'+
						'</div>' +
						'<div>' +
							'<small><span class="nickname text-secondary">' + friend.nickname + '</span></small>' +
						'</div>' +
					'</div>' +
				'</div>' +
				'<div class="card-body p-2">' +
					'<div class="media">' +
						'<img src="' + base_LIVE_Url + friend.avatar + '" class="align-self-start mr-3 rounded" alt="' + friend.displayname + '">' +
						'<div class="media-body align-self-center">' +
							'<button type="button" class="btn btn-' + (friend.following ? 'dark' : 'success') + ' btn-sm follow" data-nickname="' + friend.nickname + '" data-action="' + (friend.following ? 'unfollow' : 'follow') + '"><i class="fas fa-user-' + (friend.following ? 'minus' : 'plus') + '"></i><span class="d-md-none d-lg-inline"> ' + (friend.following ? 'Unfollow' : 'Follow') + '</span></button>' +
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
		
		var only_my_contacts = false;
		if ($('button#my_contacts').hasClass('btn-success')) only_my_contacts = true;

		var search_input = $(this).val().trim().toLowerCase();
		
		var my_contacts = $('.my_contacts');
		my_contacts.addClass('d-none');
		var my_contacts_row = my_contacts.find('.row');
		var my_contacts_no_search = $(my_contacts).find('.alert');
		my_contacts_no_search.addClass('d-none');
		
		var live_contacts = $('.live_contacts');
		live_contacts.addClass('d-none');
		var live_row = live_contacts.find('.row');
		live_row.html('');
		var live_contacts_no_search = $(live_contacts).find('.alert');
		live_contacts_no_search.addClass('d-none');
		

		if (only_my_contacts)
		{
			my_contacts.removeClass('d-none');
		}
		else
		{
			live_contacts.removeClass('d-none');
		}
		
		
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
		if (search_input.length >= 3) {
			live_row.html('<div class="text-center text-secondary mt-4"><i class="fas fa-spinner fa-spin fa-5x"></i></center>');
			chrome.runtime.sendMessage({
				type: 'SearchContact',
				LIVE_Token: Rsi_LIVE_Token,
				Query: search_input,
			}, function (result) {
				live_row.html('');
				if (result.success == 1) {
					found_contacts = result.data.resultset;

					$(found_contacts).each(function (id, friend) {							
						append_contact(live_row, id, friend);
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
			live_contacts_no_search.removeClass('d-none alert-danger').addClass('alert-warning').html('You need to enter 3 characters minimum to enable live search.');
			
			if (search_input.length == 0) $('button#live_contacts span.nb_contacts').text('(0)');
		}
	});


	// Follow / unfollow friend
	$(document).on('click', 'button.follow', function () {
		var button = $(this);

		var nickname = button.data('nickname');
		var action = button.data('action');

		var add = true;
		if (action == "unfollow") add = false;

		if (nickname.length > 3) {
			chrome.runtime.sendMessage({
				type: 'addtoFriendList',
				LIVE: true,
				Token: Rsi_LIVE_Token,
				Nickname: nickname,
				Add: add,
			}, function (result) {
				if (result.success == 1) {
					button.toggleClass('btn-dark').toggleClass('btn-success');
					button.find('i').toggleClass('fa-user-minus').toggleClass('fa-user-plus');

					if (add) {
						button.data('action', 'unfollow');
						button.find('span').text(' Unfollow');
					} else {
						button.data('action', 'follow');
						button.find('span').text(' Follow');
					}
				}
			});
		}

	});

	// Click on button (to filter the search only for the contact you owned or from Citizen search)
	$(document).on('click', '#page_Contacts .page-content button.btn:not(".contacts_sort")', function () {
		$('#page_Contacts .page-content button.btn:not(".contacts_sort")').attr('class', 'btn btn-secondary');
		$(this).toggleClass('btn-secondary').toggleClass('btn-success');
		
		$('.my_contacts, .live_contacts').addClass('d-none');
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
			type: 'getFriendList',
			LIVE: true,
			Token: Rsi_LIVE_Token,
		}, function (result) {
			var LIVE_friend_list = result.data;

			// GET PTU friend list
			chrome.runtime.sendMessage({
				type: 'getFriendList',
				LIVE: false,
				Token: Rsi_PTU_Token,
			}, function (result) {
				var PTU_friend_list = result.data;

				$('#contacts_added').text(0);
				$('#contacts_no_ptu').text(0);
				$('#contacts_existing').text(0);

				var contact_type = '';

				$(LIVE_friend_list).each(function (i, friend) {

					// if friend is not already in PTU account
					if (!PTU_friend_list.some(e => e.nickname === friend.nickname)) {
						// we try to add that friend
						chrome.runtime.sendMessage({
							type: 'addtoFriendList',
							LIVE: false,
							Token: Rsi_PTU_Token,
							Nickname: friend.nickname,
							Add: true,
						}, function (result) {
							if (result.success) {
								contact_type = 'contacts_added';
								$('#contacts_added').text(parseInt($('#contacts_added').text()) + 1);
							} else {
								contact_type = 'contacts_no_ptu';
								$('#contacts_no_ptu').text(parseInt($('#contacts_no_ptu').text()) + 1);
							}

							$('#log table tbody').append('' +
								'<tr class="' + contact_type + '">' +
									'<td class="align-middle">' +
										'<img src="' + base_LIVE_Url + friend.avatar + '" alt="' + friend.displayname + '" class="img-responsive rounded friend_logo">' +
									'</td>' +
									'<td class="align-middle">' +
										'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + ' <small><i class="fas fa-external-link"></i></small></a>' +
									'</td>' +
									'<td class="align-middle text-' + (result.success ? 'success' : 'danger') + '">' +
										'<i>' + (result.success ? 'Added' : 'NO PTU account<br />') + '</i>' +
									'</td>' +
								'</tr>' +
								'');
						});
					} else {
						// Friend already added
						contact_type = 'contacts_existing';
						$('#contacts_existing').text(parseInt($('#contacts_existing').text()) + 1);

						$('#log table tbody').append('' +
							'<tr class="' + contact_type + '">' +
								'<td class="align-middle">' +
									'<img src="' + base_LIVE_Url + friend.avatar + '" alt="' + friend.displayname + '" class="img-responsive rounded friend_logo">' +
								'</td>' +
								'<td class="align-middle">' +
									'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + ' <small><i class="fas fa-external-link"></i></small></a>' +
								'</td>' +
								'<td class="align-middle text-warning">' +
									'<i>Already added</i>' +
								'</td>' +
							'</tr>' +
							'');
					}
				});

				$('#log, #summary').removeClass('d-none');
				$('#btn_sync_contact > i.fa-sync').removeClass('fa-spin');
				$('#btn_sync_contact > span:eq(0)').removeClass('d-none');
				$('#btn_sync_contact > span:eq(1)').addClass('d-none');
			});
		});
	});
});