function LeftMenu_Click_Ships(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		chrome.runtime.sendMessage({
			type: 'getShipListCachedSince',
		}, function(ShipListCachedSince){			
			var cached_since = 'Never';
			if (ShipListCachedSince.success == 1)
			{
				cached_since = timeSince(ShipListCachedSince.cached_since);
				refresh_ShipList_data(href, false);
			}
			else refresh_ShipList_data(href, true);
			$(href + ' .cached_since').removeClass('d-none').find('code').text(cached_since);
		});
	}
}


function refresh_ShipList_data(href, refresh)
{
	$('#ShipListRefresh').attr('disabled', true).find('i').addClass('fa-spin');
	
	elem_ship_li_a = $('a.nav-link[href="' + href + '"]');
	elem_ship_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	
	$(href + ' .cached_since').removeClass('d-none').find('code').text('in progress...');
	
	// Get Ship list
	chrome.runtime.sendMessage({
		type: 'getShipList',
		Token: Rsi_LIVE_Token,
		refresh: refresh,
	}, (ShipList) => {
		
		$('#ShipListRefresh').attr('disabled', false).find('i').removeClass('fa-spin');
		elem_ship_li_a.find('.badge').html(0);
		
		if (ShipList.success == 1)
		{
			window.scrollTo(0, 0);
			cached_since = timeSince(ShipList.cached_since);
			$(href + ' .cached_since').removeClass('d-none').find('code').text(cached_since);
		
			var ships = ShipList.data.ships;
			if (typeof ships == "undefined") ships = [];
			ships.sortAscOn('sorted_name');
			
			var loaners = ShipList.data.loaners;
			if (typeof loaners == "undefined") loaners = [];
			
			var loaners_inversed = ShipList.data.loaners_inversed;
			if (typeof loaners_inversed == "undefined") loaners_inversed = [];
			
			var ships_not_found = ShipList.data.ships_not_found;
			if (typeof ships_not_found == "undefined") ships_not_found = [];
			
			var report = ShipList.data.report;
			if (typeof report == "undefined") report = {ships_not_found: 0};
			
			if (typeof report.ships_not_found == "undefined") last_report = 0;
			else last_report = report.ships_not_found;
			
			current_timestamp = Math.floor(Date.now() / 1000);
	
			// we don't allow a user to send another report before 7 days
			if (ships_not_found.length > 0 && (current_timestamp - last_report) > 60*60*24*7)
			{
				$('button[data-target="#ships_not_found"]').removeClass('d-none').html('<i class="fas fa-exclamation-triangle"></i> ' + ships_not_found.length + ' ship' + (ships_not_found.length>1?'s':'') + ' not detected');
				
				$('#ships_not_found .modal-body').html('<p>The script couldn\'t detect everything apparently. Please, use the report button to warn the author about your ships not beeing detected:</p><ol></ol>');
				
				$(ships_not_found).each((index, ship_name) => {
					$('#ships_not_found .modal-body > ol').append('<li>' + ship_name + '</li>');
				});
				$('#ships_not_found .modal-body').append('<p class="text-right mb-0"><small>The report will contain only your ship name, nothing more!</small></p>');
				
				$('#ships_not_found button.send_report').attr('data-report_type', 'ships_not_found');
				$('#ships_not_found button.send_report').attr('data-report_data', JSON.stringify(ships_not_found));
			};
			
			var Ship_Status = [];
			var Ship_Focus = [];
			var Ship_Type = [];
			var Ship_Manufacturers = [];

			$(href + ' h1.h2 span').text(' (' + $(ships).length + ')');
			$(href + ' .ship_list').html('<div class="row row-cols-1 row-cols-xxs-1 row-cols-xs-2 row-cols-sm-3 row-cols-md-3 row-cols-lg-4 row-cols-xl-5 row-cols-xxxxl-6">');

			nb_ships_owned = 0;
			$(ships).each(function (i, ship) {
				if (ship.owned) nb_ships_owned = nb_ships_owned + ship.nb;
				
				if (ship.production_status !== null && ! Ship_Status.includes(ship.production_status.trim())) Ship_Status.push(ship.production_status.trim());
				
				if (ship.focus !== null && ! Ship_Focus.includes(ship.focus.trim())) Ship_Focus.push(ship.focus.trim());
				
				if (ship.type !== null && ! Ship_Type.includes(ship.type.trim())) Ship_Type.push(ship.type.trim());
				
				if (typeof(ship.manufacturer) != "undefined")
				{
					manufacturer = ship.manufacturer;
					manufacturer.name_lower = manufacturer.name.toLowerCase();
					Ship_Manufacturers[manufacturer.id] = manufacturer;
				}
				
				var span_ship_production_status = '';
				if (ship.production_status !== null) {
					var ship_production_status = ship.production_status.split('/');
					$(ship_production_status).each(function (index, val) {
						span_ship_production_status = span_ship_production_status + '<span class="mr-1 mb-1 badge badge-primary">' + capitalizeFirstLetter(val) + '</span> '
					})
				}

				var span_ship_type = '';
				if (ship.type !== null) {
					var ship_type = ship.type.split('/');
					$(ship_type).each(function (index, val) {
						span_ship_type = span_ship_type + '<span class="mr-1 mb-1 badge badge-warning">' + capitalizeFirstLetter(val) + '</span> '
					})
				}

				var span_ship_focus = '';
				if (ship.focus !== null) {
					var ship_focus = ship.focus.split('/');
					$(ship_focus).each(function (index, val) {
						span_ship_focus = span_ship_focus + '<span class="mr-1 mb-1 badge badge-danger">' + capitalizeFirstLetter(val) + '</span> '
					})
				}
				
				ship_image = ship.media[0].images.slideshow;
				if (! ship_image.includes('http')) ship_image = base_LIVE_Url + ship_image;

				$(href + ' .ship_list > .row').append('' +
					'<div class="col mb-4 d-none">' +
						'<a href="' + base_LIVE_Url + ship.url.substr(1) + '" target="_blank">' +
							'<div class="card bg-dark text-light" data-id="' + ship.id + '" data-owned="' + ship.owned + '" data-nb="' + ship.nb + '"  data-loaner="' + ship.loaner + '" data-name="' + ship.name + '" data-manufacturer_id="' + ship.manufacturer.id + '" data-manufacturer="' + ship.manufacturer.name + '" data-production_status="' + ship.production_status + '" data-type="' + ship.type + '" data-ship_focus="' + ship.focus + '" data-nb_found="0">' +
								'<img class="card-img-top" src="' + ship_image + '" alt="' + ship.name + '" />' +
								(ship.owned?'<span class="owner badge badge-success">x' + ship.nb + '</span>':'') +
								(ship.loaner?'<span class="owner loaner badge badge-warning">Loaner</span>':'') +
								'<div class="card-body p-1 m-0">' +
									'<div class="pb-2">' +
										'<h6 class="m-0">' + (ShipList.data.dev?'[' + ship.id + '] - ':'') + ship.name + '</h6>' +
									'</div>' +
									'<div class="d-flex flex-wrap">' +
										span_ship_production_status.trim() +
										span_ship_type.trim() +
										span_ship_focus.trim() +
									'</div>' +
								'</div>' +
							'</div>' +
						'</a>' +
					'</div>' +
				'');
			});
			$(href + ' .ship_list > .row').append('</div>');
			
			$(loaners).each(function (i, ship_id) {
				ship_card = $(href + ' .ship_list > .row .card[data-id="' + ship_id + '"]');
				
				var loaner_from_name = [];
				// Searching from which ship this loaner is coming from:
				if (typeof loaners_inversed[ship_id] != "undefined" && loaners_inversed[ship_id] != null)
				{
					// get loaner info
					ship_loner_info = ships.find(element => element.id == ship_id);
					if (typeof ship_loner_info != "undefined")
					{
						$(loaners_inversed[ship_id]).each(function (i, ship_id_from) {
							// get original ship info
							ship_info = ships.find(element => element.id == ship_id_from);
							
							if (typeof ship_info != "undefined" && ship_info.id != ship_id)
							{
								loaner_from_name.push(ship_info.name);
							}
						});
					}
				}
				
				if (loaner_from_name.length > 0)
				{
					ship_card.find('span.loaner').text('Loaner from: ');
					ship_card.find('span.loaner').append('<i class="text-dark">' + loaner_from_name.join(', ') + '</i>');
				}
				
				ship_card.attr("data-loaned", true);
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

			$('#input_search_ships').removeClass('d-none');
			
			if (nb_ships_owned > 0) $('button#my_ships').removeClass('d-none');
			if (loaners.length > 0) $('button#my_loans').removeClass('d-none');

			if (nb_ships_owned > 1) {
				$('button#my_ships span.nb').text('(' + nb_ships_owned + ')');
			}

			if (loaners.length > 1) {
				$('button#my_loans span.plurial').text('s');
				$('button#my_loans span.nb').text('(' + loaners.length + ')');
			}

			elem_ship_li_a.find('.badge').text(nb_ships_owned + "/" + $(ships).length);
		}
		else
		{
			elem_ship_li_a.parent().addClass('d-none');
			$(href + ' .cached_since').removeClass('d-none').find('code').text('Something wen\'t wrong');
		}
		
		$('#ships_search').keyup();
	});
}

$(document).ready(function () {
	
	$(document).on('mouseover', '#page_Ships .ship_list a', function () {
		$(this).find('.card').removeClass('bg-dark').addClass('bg-thirdary border-highlighted');
	});
	
	$(document).on('mouseout', '#page_Ships .ship_list a', function () {
		$(this).find('.card').removeClass('bg-thirdary border-highlighted').addClass('bg-dark');
	});
	
	$(document).on('click', '#ShipListRefresh', function () {
		refresh_ShipList_data('#page_Ships', true);
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
			var loaner = $(this_card).data('loaner');

			$(keywords).each(function (index, keyword) {
				if (keyword.length == 0) keywords.splice(index, 1);
				else if (
					name.includes(keyword) ||
					manufacturer.includes(keyword) ||
					production_status.includes(keyword) ||
					type.includes(keyword) ||
					ship_focus.includes(keyword) ||
					(keyword == "owned" && owned == true) ||
					(keyword == "loaner" && loaner == true)
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