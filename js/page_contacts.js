function LeftMenu_Click_Contacts(elem, href)
{
	if (Rsi_LIVE_Token === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		$(href + ' .content .my_contacts_list').html('');

		// Collecting Organization of current user
		chrome.runtime.sendMessage({
			type: 'getFriendList',
			LIVE: true,
			Token: Rsi_LIVE_Token,
		}, (result) => {
			if (result.success == 1) {
				var friendlist = result.data;
				friendlist.sortAscOn('displayname');

				elem.find('.badge').text($(friendlist).length);

				var nb_contacts = 0;
				$(friendlist).each(function (i, friend) {
					nb_contacts++;

					$(href + ' .content .my_contacts_list').append('' +
						'<div class="col mb-4">' +
							'' +
								'<div class="card bg-dark" data-nickname="' + friend.nickname + '" data-displayname="' + friend.displayname + '">' +
									'<div class="card-header p-1">' +
										'<div class="media-body">' +
											'<div class="displayname">' +
												'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + '</a>' +
											'</div>' +
											'<div>'+
												'<small><span class="nickname text-secondary">' + friend.nickname + '</span></small>' +
											'</div>' +
										'</div>' +
									'</div>' +
									'<div class="card-body p-2">' +
										'<div class="media">' +
											'<img src="' + base_LIVE_Url + friend.avatar + '" class="align-self-start mr-3 rounded" alt="' + friend.displayname + '">' +
											'<div class="media-body align-self-center">' +
												'<button type="button" class="btn btn-dark btn-sm follow" data-nickname="' + friend.nickname + '" data-action="unfollow"><i class="fas fa-user-minus"></i><span class="d-md-none d-lg-inline"> Unfollow</span></button>' +
											'</div>' +
										'</div>' +
									'</div>' +
								'</div>' +
							'' +
						'</div>' +
						'');
				});

				$('#input_search_contacts').removeClass('d-none');

				$('button#my_contacts').removeClass('d-none').addClass('active').addClass('btn-success');
				if (nb_contacts > 1) {
					$('button#my_contacts span.plurial').text('s');
					$('button#my_contacts span.nb_my_contacts').text('(' + nb_contacts + ')');
				}

				$('#contacts_search').val('');
				$('#contacts_search').keyup();
			}
		});
	}
}

$(document).ready(function () {
	// Contact ships
	$(document).on('keyup', '#contacts_search', function () {
		var only_my_contacts = false;
		if ($('button#my_contacts').hasClass('active')) only_my_contacts = true;

		var search_input = $(this).val().trim().toLowerCase();


		if (only_my_contacts) {
			$('.contacts_list').addClass('d-none')
			var contact_form = $('.my_contacts_list');

			contact_form.children().addClass('d-none');

			contact_form.find('.card').attr("data-nb_found", 0);

			keywords = search_input.split(' ');

			contact_form.find('.card').each(function (i, this_card) {
				var nickname = $(this_card).data('nickname');
				if (nickname != 'null') nickname = nickname.toLowerCase();
				else nickname = '';

				var displayname = $(this_card).data('displayname');
				if (displayname != 'null') displayname = displayname.toLowerCase();
				else displayname = '';

				$(keywords).each(function (index, keyword) {
					if (
						nickname.includes(keyword) ||
						displayname.includes(keyword)
					) {
						// keyword found
						nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;

						$(this_card).attr("data-nb_found", nb_found);
					}

				});
			});

			var found_contacts = contact_form.find('.card[data-nb_found="' + keywords.length + '"]');

			if (found_contacts.length == 0) $('button#my_contacts').click();

			found_contacts.parent().removeClass('d-none');

			if (only_my_contacts) $('button#my_contacts span.nb_my_contacts').text('(' + found_contacts.length + ')');
			else $('button#my_contacts span.nb_my_contacts').text('');

		} else {
			$('.my_contacts_list').addClass('d-none')
			var contact_form = $('.contacts_list')
			$(contact_form).html('');

			if (search_input.length >= 3) {
				chrome.runtime.sendMessage({
					type: 'SearchContact',
					LIVE_Token: Rsi_LIVE_Token,
					Query: search_input,
				}, function (result) {
					contact_form.addClass('row row-cols-1 row-cols-xs-1 row-cols-md-3 row-cols-lg-4 row-cols-xl-8').html('');
					if (result.success == 1) {
						var contacts_found = result.data.resultset;

						var nb_contacts = 0;
						$(contacts_found).each(function (i, friend) {
							nb_contacts++;

							contact_form.append('' +
								'<div class="col mb-4">' +
									'' +
									'<div class="card bg-dark" data-nickname="' + friend.nickname + '" data-displayname="' + friend.displayname + '">' +
										'<div class="card-header p-1">' +
											'<div class="media-body">' +
												'<div class="displayname">'+
													'<a href="' + base_LIVE_Url + 'citizens/' + friend.nickname + '" target="_blank">' + friend.displayname + '</a>'+
												'</div>' +
												'<div>' +
													'<small><span class="nickname text-dark">' + friend.nickname + '</span></small>' +
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
									'' +
								'</div>' +
								'');
						});
					}
				});
			} else if (search_input.length >= 1) {
				$(contact_form).attr('class', 'contacts_list').html('<div class="alert alert-warning" role="alert">You need to type 3 characters minimum</div>')
			}
		}

		contact_form.removeClass('d-none');


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

	// Click "My contacts only" button (to filter the search only for the contact you owned)
	$(document).on('click', 'button#my_contacts', function () {
		$(this).toggleClass('active').toggleClass('btn-secondary').toggleClass('btn-success');

		$('#contacts_search').keyup();
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