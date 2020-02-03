function LeftMenu_Click_Organizations(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		// Collecting Organization of current user
		chrome.runtime.sendMessage({
			type: 'getOrganizations',
			handle: handle
		}, (result) => {
			if (result.success == 1) {
				$(href + ' .content .my_organizations').html('');
				elem.find('.badge').text($(result.organizations).length);

				$(result.organizations).each(function (i, organization) {
					$(href + ' .content .my_organizations').append('' +
						'<div class="col mb-2">' +
							'' +
								'<div class="card bg-dark" data-SID="' + organization.SID + '" data-name="' + organization.name + '">' +
									'<div class="card-header p-1">' +
										'<div class="media-body">' +
											'<div class="displayname">'+
												'<a href="' + base_LIVE_Url + 'orgs/' + organization.SID + '/members" target="_blank">' + organization.name + '</a>' +
											'</div>' +
										'</div>' +
									'</div>' +
									'<div class="card-body p-2">' +
										'<div class="media">' +
											'<img src="' + base_LIVE_Url + organization.logo + '" class="align-self-start mr-3" alt="' + organization.name + '">' +
											'<div class="media-body align-self-center">' +
												'<div class="mb-2">'+
													'Members: ' + organization.nb_member + '<br />Rank: ' + organization.rank + '<br />Level: ' + organization.level_number + '/5'+
												'</div>' +
												'<div><button type="button" class="btn btn-sm btn-dark text-warning btn_follow_organization" data-sid="' + organization.SID + '"><i class="fas fa-user-plus"></i> Follow ' + (organization.nb_member - 1) + ' member' + (organization.nb_member - 1 > 1 ? 's' : '') + '</button></div>' +
												'<div><button type="button" class="mt-2 btn btn-sm btn-dark text-warning btn_organization_member" data-sid="' + organization.SID + '" data-nb_member="' + organization.nb_member + '"><i class="fas fa-users"></i> <span>Show</span> member' + (organization.nb_member > 1 ? 's' : '') + '</button></div>' +
											'</div>' +
										'</div>' +
									'</div>' +
									'<div class="d-none org_members mt-2" data-sid="' + organization.SID + '">' +
										'<div class="row row-cols-2 row-cols-xs-2 row-cols-md-3 row-cols-lg-4 row-cols-xl-8 ml-4 mr-4"></div>' +
									'</div>' +
								'</div>' +
							'' +
						'</div>' +
						'');
				});
			}
		});
	}
}
$(document).ready(function () {
	$(document).on('click', 'button.btn_organization_member', function () {
		var button = $(this);
		var SID = button.data('sid');
		//var nb_member = button.data('nb_member');
		
		elem = $('.org_members[data-sid="' + SID + '"]');
		member_form = $('.org_members[data-sid="' + SID + '"] > div').html('');

		if (typeof SID !== 'undefined' && SID.length > 0 && Rsi_LIVE_Token !== false && elem.hasClass('d-none')) {
			button_text = button.html();
			button.html('<i class="fad fa-spinner-third fa-spin"></i>');
			elem.removeClass('d-none');
			
			//check if connected by trying to remove a contact with no name
			chrome.runtime.sendMessage({
				type: 'getOrgMembers',
				Token: Rsi_LIVE_Token,
				SID: SID,
				Handle: handle,
			}, function (result) {
				if (result.success == 1) {
					members = result.data;
					
					$(members).each((index, member) => {						
						member_form.append('' +
						'<div class="col mb-4">' +
							'' +
							'<div class="card bg-secondary" data-nickname="' + member.nickname + '" data-displayname="' + member.displayname + '">' +
								'<div class="card-header p-1">' +
									'<div class="media-body">' +
										'<div class="displayname">'+
											'<a href="' + base_LIVE_Url + 'citizens/' + member.nickname + '" target="_blank">' + member.displayname + '</a>'+
										'</div>' +
										'<div>' +
											'<small><span class="nickname text-secondary">' + member.nickname + '</span></small>' +
										'</div>' +
									'</div>' +
								'</div>' +
								'<div class="card-body p-2">' +
									'<div class="media">' +
										'<img src="' + base_LIVE_Url + member.avatar + '" class="align-self-start mr-3 rounded" alt="' + member.displayname + '">' +
										'<div class="media-body align-self-center">' +
											'<button type="button" class="btn btn-' + (member.following ? 'dark' : 'success') + ' btn-sm follow" data-nickname="' + member.nickname + '" data-action="' + (member.following ? 'unfollow' : 'follow') + '"><i class="fas fa-user-' + (member.following ? 'minus' : 'plus') + '"></i><span class="d-md-none d-lg-inline"> ' + (member.following ? 'Unfollow' : 'Follow') + '</span></button>' +
										'</div>' +
									'</div>' +
								'</div>' +
							'</div>' +
							'' +
						'</div>' +
						'');
					});
					
					
					button.html(button_text.replace("<span>Show</span>", "<span>Hide</span>"));
				} else {
					button.replaceWith('<code>Sorry, an error occured.</code>');
				}

			});
		}
		else
		{
			button.html(button_text.replace("<span>Hide</span>", "<span>Show</span>"));
			elem.addClass('d-none');
		}
	});
	
	
	// Follow Organization
	$(document).on('click', 'button.btn_follow_organization', function () {
		var button = $(this);
		var SID = button.data('sid');

		if (typeof SID !== 'undefined' && SID.length > 0 && Rsi_LIVE_Token !== false) {
			button.html('<i class="fad fa-spinner-third fa-spin"></i>');

			//check if connected by trying to remove a contact with no name
			chrome.runtime.sendMessage({
				type: 'addOrganizationMembers',
				Token: Rsi_LIVE_Token,
				SID: SID,
				Add: true,
				Handle: handle,
			}, function (result) {
				if (result.success == 1) {
					var this_class = '';
					if (result.data.length > 0) this_class = 'text-success';

					button.replaceWith('<code class="' + this_class + '">' + result.data.length + ' member' + (result.data.length > 1 ? 's' : '') + ' added to LIVE.</code>');
				} else {
					button.replaceWith('<code>Sorry, an error occured.</code>');
				}

			});
		}
	});
});