function LeftMenu_Click_Spectrum(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			//LeftMenu_Click(elem);
		}, 250);
	} else {
		elem.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
		CheckConnection(false, false, 'page_Spectrum.js', (connection_data) => {
			get_Threads(connection_data);
		});
	}
}


function get_Threads(connection_data)
{
	if (connection_data.live.connected)
	{
		elem = "#page_Spectrum";
		
		var container = $(elem).find('.content  .threads ul.list-unstyled');
		container.html('<div class="text-center"><h5><i class="fas fa-sync fa-spin"></i></h5></div>');
		
		var community = connection_data.live.data.communities.find(elem => elem.id == 1);
		var channel_groups = community.forum_channel_groups;
		
		if (typeof channel_groups != "undefined")
		{
			var all_forums = [];
			var all_threads = [];
			// Official => 2, StarCitizen => 2, PTU => 63927
			var forums = [1, 3, 190048];
		
			$(forums).each((index, forum) => {
				for (const key in channel_groups) {
					$(channel_groups[key].channels).each((index, channel) => {
						if (channel.id == forum) {
						all_forums.push(channel);
						}
					});
				}
			});
			
			var done = 0;
			
			$(all_forums).each((index, channel) => {
				chrome.runtime.sendMessage({
					type: 'getSpectrumThreads',
					LIVE_Token: Rsi_LIVE_Token,
					channel_id: channel.id,
				}, (result) => {
					if (result.success == 1)
					{
						$(result.data.threads).each( (i, thread) => {
							//if (thread.tracked_post_role_id == "2")
							if (thread.highlight_role_id == "2")
							{
								thread.community = community;
								thread.channel = channel;
								all_threads.push(thread)
							}
						});
					}
					
					done ++;
					
					if (done == all_forums.length) {
						
						all_threads.sortDescOn("time_created");
						
						container.html('');
						
						nb_notification = 0;

						$(all_threads).each((index, thread) => {									
							time_ago = timeSince(sanitizeHTML(thread.time_created));
							avatar = sanitizeHTML(thread.member.avatar);
							if (typeof avatar == "undefined" || avatar == null) avatar = '../img/default_avatar.jpg';
							img = '<img src="' + avatar + '" class="img-fluid rounded mr-3" alt="User Avatar" style="width: 64px;"/>';
							
							if (thread.is_new) nb_notification++;
							
							thread.slug = sanitizeHTML(thread.slug);
							thread.member.nickname = sanitizeHTML(thread.member.nickname);
							thread.channel.color = sanitizeHTML(thread.channel.color);
							thread.channel.name = sanitizeHTML(thread.channel.name);
							thread.community.slug = sanitizeHTML(thread.community.slug);
							thread.channel_id = sanitizeHTML(thread.channel_id);
							thread.id = sanitizeHTML(thread.id);
							thread.subject = sanitizeHTML(thread.subject);
							
							container.append('' +
								'<li class="media p-1 mb-2 border-bottom' + (thread.is_new?' unread bg-light text-dark':'') + '" data-slug="' + thread.slug + '">' +
									img +
									'<div class="media-body">' +
										'<div class="d-flex justify-content-between">' + 
											'<h6 class="mt-0 mb-1">' + thread.member.nickname + ' - ' + time_ago + '</h6>' +
											'<span style="color: #' + thread.channel.color + '" class="d-none d-xs-inline"><i>' + thread.channel.name + '</i></span>' +
										'</div>' +
										'<a class="notifications-item" href="' + base_LIVE_Url + 'spectrum/community/' + thread.community.slug + '/forum/' + thread.channel_id + '/thread/' + thread.slug + '" target="_blank" data-thread_id="' + thread.id + '">' + thread.subject + '</a>' +
									'</div>' +
								'</li>' +
							'');
						});
						
						$(elem).find('.content .threads .card-title > span').text('(' + nb_notification + '/' + all_threads.length + ')');
					}
				});
			})
		}
	}
}

$( document ).ready(function() {
	// When user click on the notification.
	$(document).on('click', '#page_Spectrum .notification a.notifications-item', function(e){
		
		var href = $(this).attr('href');
		
		if (href.startsWith("#"))
		{
			$('a.nav-link[href="' + href + '"]').click();
			if (href == "#page_Contacts" ) $('#pending_contacts').click();
		}
		else
		{
			chrome.runtime.sendMessage({
				type: 'SpectrumRead',
				LIVE_Token: Rsi_LIVE_Token,
				notification_id: $(this).data('notification_id'),
			}, (result) => {
				$(this).closest('li.media').removeClass('unread bg-light text-dark');
			});
		}
		
	});
	
	
	
	$(document).on('click', '#page_Spectrum button.read_all_CIG_threads', function(e){		
	
		var nb_thread_total = $('#page_Spectrum .threads li.media').length;
		var nb_thread_total_todo = $('#page_Spectrum .threads li.media.unread').length;
		
		$('#page_Spectrum .threads li.media.unread').each((index, li) => {
			nb_thread_total_todo--;
			
			slug = $(li).data('slug');
			
			chrome.runtime.sendMessage({
				type: 'SpectrumThreadNested',
				slug: slug,
				LIVE_Token: Rsi_LIVE_Token
			}, (result) => {
				$('#page_Spectrum .threads li.media').removeClass('unread bg-light text-dark');
				if (nb_thread_total_todo == 0)
				{
					$('#page_Spectrum .content .threads .card-title > span').text('(' + nb_thread_total_todo + '/' + nb_thread_total + ')');
				}
			});
		});
		
	});
	
	$(document).on('click', '#page_Spectrum button.read_all_notifications', function(e){		
		chrome.runtime.sendMessage({
			type: 'SpectrumReadAllNotifications',
			LIVE_Token: Rsi_LIVE_Token
		}, (result) => {
			$('#page_Spectrum .notification li.media').removeClass('unread bg-light text-dark');
			CheckConnection(false, true, '#page_Spectrum button.read_all_notifications', () => {
			});
		});
	});
});
