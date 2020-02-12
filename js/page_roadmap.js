function LeftMenu_Click_Roadmap(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		$(href + ' .content').html('<div class="text-center text-secondary mt-4"><i class="fas fa-spinner fa-spin fa-5x"></i></center>');
		
		$('#roadmap_roundup, #page_Roadmap button.prev, #page_Roadmap button.next').addClass('d-none');
		$('#page_Roadmap button.prev, #page_Roadmap button.next').attr("disabled", true);
		$('#page_Roadmap .timeSince').text('');
		
		// Get Roadmap information
		chrome.runtime.sendMessage({
			type: 'getBoards',
		}, (result) => {
			//elem.find('.badge').html('');

			if (result.success == 1) {
				window.scrollTo(0, 0);
				
				$(href + ' .content').html('<div class="boards row col row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-3 row-cols-xl-4 row-cols-xxl-5 row-cols-xxxl-6"></div>');
				boards = result.data.boards;
				$(boards).each(function (index, board) {
					$(href + ' .content .boards').append('' +
						'<div class="col mb-4">' +
							'<div class="card bg-dark cursor getboard" data-id="' + board.id + '" data-name="' + board.name + '" data-last_updated="' + board.last_updated + '">' +
								'<div class="card-header p-1 m-0">' + board.name + '</div>' +
								'<div class="card-body text-center text-warning">' +
									'<img class="img-fluid img_roadmap" src="' + base_LIVE_Url + board.thumbnail.urls.square + '" alt="' + board.name + '" />' +
									'<div class="update_in_progress d-none">CIG is most likely updating the Roadmap right now. Come back in few minutes.</div>' +
								'</div>' +
								'<div class="card-footer p-1 m-0 text-right" title="' + board.last_updated + '"><i>Updated ' + timeSince(board.last_updated) + '</i></div>' +
							'</div>' +
						'</div>' +
						'');

					$(href + ' .content').append('<div class="board board-' + board.id + ' d-none"></div>');
				});
			}
		});
	}
}


function find_difference(card, current_release, previous_releases)
{
	found = false;
	moved = false;
	
	var text = '';
	
	$(previous_releases).each( (index, previous_release) => {
		if (found === false)
		{
			$(previous_release.cards).each(function (index, previous_card) {
				if (found === false && card.id == previous_card.id)
				{
					// card was already there in previous roadmap
					found = true;
					
					if (previous_release.id != current_release.id && previous_release.name != current_release.name)
					//if (previous_release.name != current_release.name)
					{
						// card was already there but has been moved
						moved = true;
						text = previous_release.name;
					}
					else
					{
						// card was already there, in the same release
						moved = false;
					}
				}
			});
		}
		
	});
	
	if (found === false)
	{
		// wasn't there in previous roadmap 
		return ({id_changed: 'NEW', extra: ''})
	}
	else 
	{
		if (moved) return ({id_changed: "MOVED", extra: text});
		return false;
	}
}


function find_missing(previous_releases, current_releases)
{
	removed = [];
	previous_cards = [];
	
	$(previous_releases).each( (index, previous_release) => {
		if (previous_release.released == 0)
		{
			$(previous_release.cards).each(function (index, previous_card) {
				found = false;
				$(current_releases).each( (index, current_release) => {
					$(current_release.cards).each(function (index, current_card) {
						if (previous_card.id == current_card.id)
						{
							found = true;
							previous_cards[current_card.id] = previous_card;
						}
					});
				});
				if (!found)
				{
					if (typeof removed[previous_release.id] == "undefined") removed[previous_release.id] = [];
					removed[previous_release.id].push({release: previous_release, card: previous_card});
				}
			});
		}
		
	});
	
	return {removed: removed, previous_cards: previous_cards};
}


function display_card(current_card, id_changed, extra, previous_card)
{
	var badge = '';
	switch (id_changed)
	{
		case "REMOVED": badge = '<span class="mr-1 badge badge-danger">REMOVED</span>'; break;
		case "NEW": badge = '<span class="mr-1 badge badge-success">NEW</span>'; break;
		case "MOVED": badge = '<span class="mr-1 badge badge-warning">MOVED from ' + extra + '</span>'; break;
	}
	
	var progress_now = (current_card.tasks > 0 ? (Math.round(current_card.completed / current_card.tasks * 100)) : 0);
	
	if (typeof previous_card == "undefined") previous_card = false;
	
	var progress_one = 0;
	if (previous_card !== false)
	{
		progress_one = (previous_card.tasks > 0 ? (Math.round(previous_card.completed / previous_card.tasks * 100)) : 0);
	}
	var progress_two = progress_now - progress_one;
	
	went_back = false;
	if (progress_two < 0)
	{
		went_back = true;
		progress_one = progress_now + progress_two;
		progress_two = progress_two * -1;
		
	}
	
	var completed = {display_bar: true, text: false};
	if (progress_now == 100)
	{
		if (progress_two == 0) completed = {display_bar: false, text: '<i class="fas fa-check-square text-light mr-1"></i>'};
		else completed = {display_bar: true, text: '<i class="fas fa-check-square text-success mr-1"></i>'};
	}
	
	return(''+
		'<div class="col-12 mb-2" data-card>' +
			'<div class="card bg-thirdary" data-id="' + current_card.id + '" data-name="' + current_card.name + '">' +
				'<div class="card-header cursor noselect p-1 m-0">' +
					'<div class="card_title' + (id_changed == "REMOVED"?" text-danger":(id_changed == "NEW"?" text-success":(id_changed == "MOVED"?" text-warning":''))) + '">' + 
						(completed.text?completed.text:'') + badge + current_card.name + '<i class="fas fa-plus-hexagon deploy mr-2 float-right text-light"></i>' +
					'</div>' +
					'<div class="progress mt-1 bg-light' + (progress_now == 0 || !completed.display_bar? ' d-none' : '') + '" data-inprogress="' + current_card.inprogress + '" data-tasks="' + current_card.tasks + '" data-completed="' + current_card.completed + '" data-released="' + current_card.released + '">' +
						'<div class="progress-bar bg-one" role="progressbar" style="width: ' + progress_one + '%;" aria-valuenow="' + progress_one + '" aria-valuemin="0" aria-valuemax="100">' +
						'</div>' +
						'<div class="progress-bar progress-bar-striped ' + (went_back?'bg-three':'bg-two') + '" role="progressbar" style="width: ' + progress_two + '%;" aria-valuenow="' + progress_two + '" aria-valuemin="0" aria-valuemax="100">' +
							(went_back?'':'NEW') +
						'</div>' +
					'</div>' +
				'</div>' +
				(current_card.thumbnail != null && current_card.thumbnail.urls != null && current_card.thumbnail.urls.rect != null ? '<img src="' + base_LIVE_Url + current_card.thumbnail.urls.rect + '" class="img-fluid rounded img_roadmap_card mt-1 d-none" alt="' + current_card.name + '">' : '') +
				'<div class="card-body p-1 m-0 description d-none">' +
					'<div class="progress bg-dark' + (progress_now == 0 || progress_now == 0 ? ' d-none' : '') + '" data-inprogress="' + current_card.inprogress + '" data-tasks="' + current_card.tasks + '" data-completed="' + current_card.completed + '" data-released="' + current_card.released + '">' +
						'<div class="progress-bar ' + (progress_now == 100 ? 'bg-success' : (progress_now > 75 ? 'bg-info' : (progress_now > 50 ? 'bg-warning' : 'bg-danger'))) + '" role="progressbar" style="width: ' + progress_now + '%;" aria-valuenow="' + progress_now + '" aria-valuemin="0" aria-valuemax="100">' +
							'' + progress_now + '%' +
						'</div>' +
					'</div>' +
					'<div class=" p-1 m-0 text-light"><strong>' + current_card.description + '</strong></div>' +
					'<div class=" p-1 m-0 text-secondary"><i>' + current_card.body + '</i></div>' +
				'</div>' +
			'</div>' +
		'</div>' +
	'');
}

function validURL(str) {
  var pattern = new RegExp('^(https?:\\/\\/)?'+ // protocol
    '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|'+ // domain name
    '((\\d{1,3}\\.){3}\\d{1,3}))'+ // OR ip (v4) address
    '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+ // port and path
    '(\\?[;&a-z\\d%_.~+=-]*)?'+ // query string
    '(\\#[-a-z\\d_]*)?$','i'); // fragment locator
  return !!pattern.test(str);
}


function get_board(board_id, board_last_updated)
{
	$('#page_Roadmap button.prev, #page_Roadmap button.next').removeClass('d-none');
	
	chrome.runtime.sendMessage({
		type: 'getBoardData',
		BoardID: board_id,
		BoardLastUpdated: board_last_updated,
	}, function (result) {
		if (result.success == 1) {
			window.scrollTo(0, 0);
			
			$('div.card[data-id="' + board_id + '"] .update_in_progress').addClass('d-none');
			
			var current = result.data.curr.data;
			var current_releases = current.releases;
			var current_categories = current.categories;
			
			var previous = result.data.prev.data;
			if (typeof previous == "undefined")
			{
				previous = current;
				prev_last_updated = false;
			}
			else prev_last_updated = previous.last_updated;
			
			var previous_releases = previous.releases;
			var previous_categories = previous.categories;
			
			var next = result.data.next.data;
			
			if (prev_last_updated) $('#page_Roadmap button.prev').attr("disabled", false).data('id', board_id).data('last_updated', prev_last_updated);
			
			var next_last_updated = false;
			if (typeof next != "undefined") next_last_updated = next.last_updated;
			if (next_last_updated) $('#page_Roadmap button.next').attr("disabled", false).data('id', board_id).data('last_updated', next_last_updated);
			
			var missing = find_missing(previous_releases, current_releases);
			
			var current_date = new Date(current.last_updated*1000);
			
			const options = { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' };
			$('#page_Roadmap span.timeSince').text(current_date.toLocaleDateString(undefined, options));
			
			if (current.notification_enabled == 1)
			{					
				current.notification_body = current.notification_body.replace(')','');
				var matches = current.notification_body.match(/\bhttps?:\/\/\S+/gi);
			
				if (typeof matches !== undefined && validURL(matches)) $('#roadmap_roundup').attr('href', matches).removeClass('d-none');
			}
			else
			{
				$('#roadmap_roundup').addClass('d-none');
			}

			$('.board-' + board_id).html('').removeClass('d-none');;


			$('.board-' + board_id).append('<div class="row col row-cols-1 row-cols-xxs-1 row-cols-xs-2 row-cols-sm-3 row-cols-md-3 row-cols-lg-3 row-cols-xl-4 row-cols-xxl-4 row-cols-xxxl-5 row-cols-xxxxl-5"></div>');

			$(current_releases).each(function (index, release) {
				if (release.cards.length > 0) {
					
					$('.board-' + board_id + ' > .row').append('' +
						'<div class="release-' + release.id + (release.released == 1 ? ' d-none' : '') + ' col mb-2 pl-2 pr-0" data-name="' + release.name + '" data-released="' + release.released + '">' +
							'<div class="card bg-dark mb-2">' +
								'<h2 class="card-header cursor noselect p-1 m-0 text-center">' + release.name + '<i class="fas fa-minus-hexagon deploy mr-3 mt-1 float-right text-dark"></i></h2>' +
								'<div class="card-body p-2 m-0">' +
									'<div class="row release"></div>' +
								'</div>' +
							'</div>' +
						'</div>' +
					'');

					$(current_categories).each(function (index, category) {
						missing_in_this_category = '';
						
						if (typeof missing.removed[release.id] !== "undefined")
						{
							$(missing.removed[release.id]).each( (index, missing_in_this_release) => {
								$(missing_in_this_release).each( (index, elem) => {
									if (elem.card.category_id == category.id)
									{
										missing_in_this_category = missing_in_this_category + display_card (elem.card, "REMOVED", "");
									}
								});
							});
						}
						
						
						$('.board-' + board_id + ' > .row .release-' + release.id + ' .card-body > .row.release').append('' +
							'<div class="col-12 mb-2" data-dategory>' +
								'<div class="card bg-secondary text-light" data-id="' + category.id + '" data-name="' + category.name + '">' +
									'<div class="card-header cursor noselect p-1 m-0 ml-2 category-title">' + 
										category.name + '<i class="fas fa-minus-hexagon deploy mr-3 mt-1 float-right text-dark"></i>' +
									'</div>' +
									'<div class="card-body p-2 m-0 category-' + category.id + '">' +
										'<div class="row category">' +
											missing_in_this_category + 
										'</div>' +
									'</div>' +
								'</div>' +
							'</div>' +
						'');
					});

					$(release.cards).each(function (index, card) {
						difference = find_difference(card, release, previous_releases);
						
						$('.board-' + card.board_id + ' > .row .release-' + card.release_id + ' .card-body .row.release .category-' + card.category_id + ' .row.category').append(display_card(card, difference.id_changed, difference.extra, missing.previous_cards[card.id]));
					});
				}

			});

			$('.row.category').each(function (index) {
				if ($(this).find('div').length == 0) $(this).parent().parent().parent().addClass('d-none');
			});

			$('[data-released="0"]:gt(0) > .card > .card-body').removeClass('d-none');

		}
		else
		{
			// Roadmap is being updated.
			$('#page_Roadmap nav > ol > li:eq(0)').click();
			$('div.card[data-id="' + board_id + '"] .update_in_progress').removeClass('d-none');
		}
	});
}

$(document).ready(function () {
	
	$(document).keydown(function(e) {
		if (!$('#page_Roadmap').hasClass('d-none'))
		{
			if(e.keyCode == 37) { // left
				$('#page_Roadmap button.prev').click();
			}
			else if(e.keyCode == 39) { // right
				$('#page_Roadmap button.next').click();
			}
		}
	});
	
	// Click on Roadmap breadcrumb
	$(document).on('click', '#page_Roadmap nav > ol > li:eq(0)', function () {
		$('#page_Roadmap nav > ol > li:gt(0)').remove();
		$('.boards').removeClass('d-none');
		$('.board').addClass('d-none');
		
		//$('#page_Roadmap nav button').addClass('d-none');
		
		$('#roadmap_roundup, #page_Roadmap button.prev, #page_Roadmap button.next').addClass('d-none');
		$('#page_Roadmap .timeSince').text('');
	});

	// Click on a Roadmap board
	$(document).on('click', '.boards .getboard', function () {
		var board_id = $(this).data('id');
		var board_name = $(this).data('name');
		var board_last_updated = $(this).data('last_updated');

		$('#page_Roadmap nav > ol > li:eq(0)').removeClass('active');
		$('#page_Roadmap nav > ol > li:gt(0)').remove();
		$('#page_Roadmap nav > ol').append('<li class="breadcrumb-item active"><span>' + board_name + '</span></li>');
		
		//$('#page_Roadmap nav button').removeClass('d-none');

		$('.boards, .board').addClass('d-none');
		
		get_board(board_id, board_last_updated);
	});
	
	$(document).on('click', '#page_Roadmap button.prev, #page_Roadmap button.next', function () {
		var board_id = $(this).data('id');
		var board_last_updated = $(this).data('last_updated');
		
		get_board(board_id, board_last_updated);
		
		$('#roadmap_roundup').addClass('d-none');
		$('#page_Roadmap button.prev, #page_Roadmap button.next').attr("disabled", true);
	});

	// Click on Roadmap Release card
	$(document).on('click', '[data-released] > .card > .card-header.cursor, [data-dategory] > .card > .card-header.cursor', function () {
		$(this).parent().find('.card-body').toggleClass('d-none');
	});

	$(document).on('click', '[data-released] > .card > .card-header.cursor', function () {
		$(this).find('i.deploy').toggleClass('fa-minus-hexagon').toggleClass('fa-plus-hexagon').toggleClass('text-light').toggleClass('text-dark');
	});

	$(document).on('click', '[data-dategory] > .card > .card-header.cursor', function () {
		$(this).find('i.deploy').toggleClass('fa-minus-hexagon').toggleClass('fa-plus-hexagon').toggleClass('text-light').toggleClass('text-dark');
	});

	$(document).on('click', '[data-card] > .card > .card-header.cursor', function () {
		$(this).parent().find('img, .description').toggleClass('d-none');
		$(this).find('i.deploy').toggleClass('fa-minus-hexagon').toggleClass('fa-plus-hexagon').toggleClass('text-light').toggleClass('text-dark');
		
		valuenow = $(this).find('.progress .progress-bar.bg-two').attr('aria-valuenow');
		if (valuenow != 0) $(this).find('.progress').toggleClass('d-none');
		
		
	});
});