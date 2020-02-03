function LeftMenu_Click_Ships(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		//$('#page_Ships .page-content button').addClass('btn-secondary').removeClass('btn-success').removeClass('active');

		$(href + ' .ship_list').html('<div class="text-center text-secondary mt-4"><i class="fas fa-spinner fa-spin fa-5x"></i></center>');

		// Get Ship list
		chrome.runtime.sendMessage({
			type: 'getShipList',
			Token: Rsi_LIVE_Token
		}, (ShipList) => {
			
			elem.find('.badge').html('');
			if (ShipList.success == 1) {
				
				var ships = ShipList.data.ships;
				var loaners = ShipList.data.loaners;

				ships.sortAscOn('sorted_name');

				$('#page_Ships h1.h2 span').text(' (' + $(ships).length + ')');

				$(href + ' .ship_list').html('<div class="row row-cols-1 row-cols-xxs-1 row-cols-xs-2 row-cols-sm-3 row-cols-md-3 row-cols-lg-4 row-cols-xl-5 row-cols-xxxxl-6">');

				nb_ships_owned = 0;
				$(ships).each(function (i, ship) {
					if (ship.owned) nb_ships_owned++;
					
					var span_ship_production_status = '';
					if (ship.production_status !== null) {
						var ship_production_status = ship.production_status.split('/');
						$(ship_production_status).each(function (index, val) {
							span_ship_production_status = span_ship_production_status + '<span class="badge badge-primary mr-1">' + capitalizeFirstLetter(val) + '</span> '
						})
					}

					var span_ship_type = '';
					if (ship.type !== null) {
						var ship_type = ship.type.split('/');
						$(ship_type).each(function (index, val) {
							span_ship_type = span_ship_type + '<span class="badge badge-warning mr-1">' + capitalizeFirstLetter(val) + '</span> '
						})
					}


					var span_ship_focus = '';
					if (ship.focus !== null) {
						var ship_focus = ship.focus.split('/');
						$(ship_focus).each(function (index, val) {
							span_ship_focus = span_ship_focus + '<span class="badge badge-danger mr-1">' + capitalizeFirstLetter(val) + '</span> '
						})
					}
					
					ship_image = ship.media[0].images.slideshow;
					if (! ship_image.includes('http')) ship_image = base_LIVE_Url + ship_image;


					$(href + ' .ship_list > .row').append('' +
						'<div class="col mb-4 d-none">' +
							'<a href="' + base_LIVE_Url + ship.url.substr(1) + '" target="_blank">' +
								'<div class="card bg-dark text-light" data-id="' + ship.id + '" data-owned="' + ship.owned + '" data-name="' + ship.name + '" data-manufacturer_id="' + ship.manufacturer.id + '" data-manufacturer="' + ship.manufacturer.name + '" data-production_status="' + ship.production_status + '" data-type="' + ship.type + '" data-ship_focus="' + ship.focus + '" data-nb_found="0">' +
									'<img class="card-img-top" src="' + ship_image + '" alt="' + ship.name + '" />' +
									'<div class="card-body p-1 m-0">' +
										'<div class="pb-2">' +
											'<h6 class="m-0">' + ship.name + '</h6>' +
										'</div>' +
										'<p class="card-text">' +
											'' + span_ship_production_status.trim() + '' +
											'' + span_ship_type.trim() + '' +
											'' + span_ship_focus.trim() + '' +
										'</p>' +
									'</div>' +
								'</div>' +
							'</a>' +
						'</div>' +
						'');
				});

				$(loaners).each(function (i, ship_id) {
					$(href + ' .ship_list > .row .card[data-id="' + ship_id + '"]').attr("data-loaned", true);
				});

				$(href + ' .ship_list > .row').append('</div>');

				$('#input_search_ships').removeClass('d-none');
				if (nb_ships_owned > 0) $('button#my_ships').removeClass('d-none');
				if (loaners.length > 0) $('button#my_loans').removeClass('d-none');

				if (nb_ships_owned > 1) {
					//$('button#my_ships span.plurial').text('s');
					$('button#my_ships span.nb').text('(' + nb_ships_owned + ')');
				}

				if (loaners.length > 1) {
					$('button#my_loans span.plurial').text('s');
					$('button#my_loans span.nb').text('(' + loaners.length + ')');
				}

				elem.find('.badge').text(nb_ships_owned + "/" + $(ships).length);

			}

			$('#ships_search').keyup();

		});
	}
}

$(document).ready(function () {
	
	$(document).on('mouseover', '#page_Ships .ship_list a', function () {
		$(this).find('.card').removeClass('bg-dark').addClass('bg-thirdary border-highlighted');
	});
	
	$(document).on('mouseout', '#page_Ships .ship_list a', function () {
		$(this).find('.card').removeClass('bg-thirdary border-highlighted').addClass('bg-dark');
	});

	// Click "My ships only" button (to filter the search only for the ship you owned)
	$(document).on('click', '#page_Ships .page-content button:not(.dropdown-toggle)', function () {
		$(this).toggleClass('btn-secondary').toggleClass('btn-success').toggleClass('active');
		$(this).siblings().addClass('btn-secondary').removeClass('btn-success').removeClass('active');

		$('#ships_search').keyup();
	});

	$('#page_Ships select.selectpicker').on('changed.bs.select', function (e, clickedIndex, isSelected, previousValue) {
		$('#ships_search').keyup();
	});

	// Search ships
	$(document).on('keyup', '#ships_search', function () {
		$('#page_Ships select.selectpicker').each(function () {
			if ($(this).val() != 0) {
				$(this).selectpicker('setStyle', 'btn-secondary', 'remove');
				$(this).selectpicker('setStyle', 'btn-success', 'add');
			} else {
				$(this).selectpicker('setStyle', 'btn-success', 'remove');
				$(this).selectpicker('setStyle', 'btn-secondary', 'add');
			}
		});

		$('#page_Ships select.selectpicker').selectpicker('refresh');

		var Filter_Ship_Manufacturers = $('select#Ship_Manufacturers').val();
		var Filter_Ship_Status = $('select#Ship_Status').val();
		var Filter_Ship_Focus = $('select#Ship_Focus').val();
		var Filter_Ship_Type = $('select#Ship_Type').val();

		var only_my_ship = false;
		if ($('button#my_ships').hasClass('active')) only_my_ship = true;

		var only_my_loans = false;
		if ($('button#my_loans').hasClass('active')) only_my_loans = true;

		var search_input = $(this).val().trim().toLowerCase();

		$('.ship_list .card').attr("data-nb_found", 0).parent().parent().removeClass('d-none');

		keywords = search_input.trim().split(' ');

		$('.ship_list .card').each(function (i, this_card) {

			// Filters
			if (Filter_Ship_Manufacturers != 0) $('.ship_list .card').not('[data-manufacturer_id="' + Filter_Ship_Manufacturers + '"]').parent().parent().addClass('d-none');
			if (Filter_Ship_Status != 0) $('.ship_list .card').not('[data-production_status="' + Filter_Ship_Status + '"]').parent().parent().addClass('d-none');
			if (Filter_Ship_Focus != 0) $('.ship_list .card').not('[data-ship_focus="' + Filter_Ship_Focus + '"]').parent().parent().addClass('d-none');
			if (Filter_Ship_Type != 0) $('.ship_list .card').not('[data-type="' + Filter_Ship_Type + '"]').parent().parent().addClass('d-none');

			//if ($('.ship_list .col.d-none').length == 0) $('.ship_list .col').addClass('d-none');


			var name = $(this_card).data('name');
			if (name != 'null') name = name.toLowerCase();
			else name = '';

			var manufacturer = $(this_card).data('manufacturer');
			if (manufacturer != 'null') manufacturer = manufacturer.toLowerCase();
			else manufacturer = '';

			var production_status = $(this_card).data('production_status');
			if (production_status != 'null') production_status = production_status.toLowerCase();
			else production_status = '';

			var type = $(this_card).data('type');
			if (type != 'null') type = type.toLowerCase();
			else type = '';

			var ship_focus = $(this_card).data('ship_focus');
			if (ship_focus != null) ship_focus = ship_focus.toLowerCase();
			else ship_focus = '';

			var owned = $(this_card).data('owned');

			$(keywords).each(function (index, keyword) {
				if (keyword.length == 0) keywords.splice(index, 1);
				else if (
					name.includes(keyword) ||
					manufacturer.includes(keyword) ||
					production_status.includes(keyword) ||
					type.includes(keyword) ||
					ship_focus.includes(keyword)
				) {
					// keyword found
					nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;

					$(this_card).attr("data-nb_found", nb_found);
				}

			});
		});

		$('.ship_list .col:not(".d-none") .card[data-nb_found!="' + keywords.length + '"]').parent().parent().addClass('d-none');

		var found_ships_owned = $('.ship_list .col:not(".d-none") .card[data-owned!="true"]');
		var found_loans = $('.ship_list .col:not(".d-none") .card:not([data-loaned])');

		if (only_my_ship) found_ships_owned.parent().parent().addClass('d-none');
		else if (only_my_loans) found_loans.parent().parent().addClass('d-none');

		var found_ships = $('.ship_list .col:not(".d-none") .card');


		$('#page_Ships h1.h2 span').text(' (' + found_ships.length + '/' + $('.ship_list .card').length + ')');
	});
});