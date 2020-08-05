function LeftMenu_Click_BuyBack(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		chrome.runtime.sendMessage({
			type: 'getBuyBackCachedSince',
		}, function(BuyBackCachedSince){			
			var cached_since = 'Never';
			if (BuyBackCachedSince.success == 1)
			{
				cached_since = timeSince(BuyBackCachedSince.cached_since);
				refresh_BB_data(href, false);
			}
			else refresh_BB_data(href, true);
			$('#page_BuyBack .cached_since').removeClass('d-none').find('code').text(cached_since);
		});
	}
}

function addToCart(fromShipId, toShipId, toSkuId, pledgeId)
{
	chrome.runtime.sendMessage({
		type: 'addToCart',
		Token: Rsi_LIVE_Token,
		fromShipId: fromShipId,
		toShipId: toShipId,
		toSkuId: toSkuId,
		pledgeId: pledgeId,
	}, (result) => {
		window.open(base_LIVE_Url + "pledge/cart");
	});
	
}


function refresh_BB_data(href, refresh)
{
	//$(href + ' .buyback_list').html('<div class="text-center text-secondary mt-4"><i class="fas fa-spinner fa-spin fa-5x"></i></center>');
	$('#BuyBackRefresh').attr('disabled', true).find('i').addClass('fa-spin');
	
	elem_bb_li_a = $('a.nav-link[href="' + href + '"]');
	elem_bb_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	
	$(href + ' .cached_since').removeClass('d-none').find('code').text('in progress...');
	
	chrome.runtime.sendMessage({
		type: 'getShipList',
		Token: Rsi_LIVE_Token,
		refresh: refresh,
	}, (ShipList) => {
		
		if (ShipList.success == 1)
		{
			var ships = ShipList.data.ships;
			if (typeof ships == "undefined") ships = [];
			
			// Get Buy Back info
			chrome.runtime.sendMessage({
				type: 'getBuyBack',
				Token: Rsi_LIVE_Token,
				refresh: refresh,
			}, function(BuyBack){
				
				$('#BuyBackRefresh').attr('disabled', false).find('i').removeClass('fa-spin');
				elem_bb_li_a.find('.badge').html(0);
				
				if (BuyBack.success == 1)
				{
					window.scrollTo(0, 0);
					
					cached_since = timeSince(BuyBack.cached_since);
					$(href + ' .cached_since').removeClass('d-none').find('code').text(cached_since);

					$('#buybacktoken').parent().removeClass('d-none');
					$('#buybacktoken').text(BuyBack.data.nb_token);
					
					elem_bb_li_a.find('.badge').html(sanitizeHTML(BuyBack.data.BuyBack.length));
					
					var contained;
					var total_price = 0;
					var curency = '';
					
					$(href + ' .buyback_list').html('');
					
					$(BuyBack.data.BuyBack).each(function (i, BB) {
						BB.price = sanitizeHTML(BB.price);
						BB.id = sanitizeHTML(BB.id);
						BB.full_name = sanitizeHTML(BB.full_name);
						BB.name = sanitizeHTML(BB.name);
						BB.type = sanitizeHTML(BB.type);
						BB.option = sanitizeHTML(BB.option);
						BB.date = sanitizeHTML(BB.date);
						BB.image = sanitizeHTML(BB.image);
						BB.contained = sanitizeHTML(BB.contained);
						BB.currency = sanitizeHTML(BB.currency);
						BB.insurance = sanitizeHTML(BB.insurance);
						BB.upgrade.fromshipid = sanitizeHTML(BB.upgrade.fromshipid);
						BB.upgrade.toshipid = sanitizeHTML(BB.upgrade.toshipid);
						BB.upgrade.toskuid = sanitizeHTML(BB.upgrade.toskuid);
						
						price = parseFloat(BB.price);
						
						if (!isNaN(price)) total_price = total_price + price;
						else price = 0;

						currency = BB.currency;
						contained = '<small><ul class="mb-0 pl-4">';
						$(BB.ships).each((index, ship) => {
							if (typeof ship.ship_name != "undefined" && ship.ship_name.length > 0) contained = contained + '<li><span class="badge badge-info">Ship</span> ' + ship.ship_name + '</li>';
						});
						$(BB.items).each((index, item) => {
							if (typeof item != "undefined" && item.length > 0)
							{
								contained = contained + '<li>' + (item.includes('Upgrade')?'<span class="badge badge-warning">Upgrade</span> ':(item.includes('Star Citizen Digital Download')?'<span class="badge badge-warning">SC Game Package</span> ':'')) + item + '</li>';
							}
						});
						contained = contained + '</ul></small>';
						
						if(BB.url !== false) bb_url = sanitizeHTML(BB.url.trim());
						else bb_url = '';
						if (bb_url.length == 0) bb_url = base_LIVE_Url + 'account/buy-back-pledges';


						if (price > 0) price = price.toFixed(2);
						price = '' + price + '';
						if (price.includes('.00')) [price] = price.split('.00');
						if (price.length == 0) price = 0;
						price = parseFloat(BB.price);
						if (isNaN(price)) price = 0;
						
						label_price = '';
						if (price > 0) label_price = '<span class="mr-1 mb-1 badge badge-primary">' + numberWithCommas(price) + ' ' + BB.currency + '</span>';
						
						label_assurance = '';
						if (BB.insurance.length > 0) label_assurance = '<span class="mr-1 mb-1 badge badge-light">' + BB.insurance + '</span>';
						
						label_type = '';
						if (BB.type.length > 0) label_type = '<span class="mr-1 mb-1 badge badge-success">' + BB.type + '</span>';
						
						label_option = '';
						if (BB.option.length > 0) label_option = '<span class="mr-1 mb-1 badge badge-dark">' + capitalizeFirstLetter(BB.option) + '</span>';
						
						var ship_image = '<img class="card-img-top" src="' + BB.image + '" alt="' + BB.contained + '" />';
						
						
						if (BB.upgrade.fromshipid !== false && BB.upgrade.toshipid !== false)
						{
							// Fix image missing for Ship Upgrade...
							ship_fromIndex = ships.findIndex(element => element.id == BB.upgrade.fromshipid);
							ship_toIndex = ships.findIndex(element => element.id == BB.upgrade.toshipid);

							if (ship_fromIndex > 0 && ship_toIndex > 0)
							{
								ship_from = ships[ship_fromIndex];
								ship_to = ships[ship_toIndex];
								
								ship_from_image = sanitizeHTML(ship_from.media[0].images.wsc_event_thumb);
								if (! ship_from_image.includes('http')) ship_from_image = base_LIVE_Url + ship_from_image;
								
								ship_to_image = sanitizeHTML(ship_to.media[0].images.wsc_event_thumb);
								if (! ship_to_image.includes('http')) ship_to_image = base_LIVE_Url + ship_to_image;
								
								ship_image = '<div><img class="image_bb_upgrade" src="' + ship_from_image + '" alt="' + BB.contained + '" /><span class="mr-1 mb-1 badge badge-warning">From</span></div>';
								ship_image += '<div><img class="image_bb_upgrade" src="' + ship_to_image + '" alt="' + BB.contained + '" /><span class="mr-1 mb-1 badge badge-warning">To</span></div>';
							}
						}
						
						$(href + ' .buyback_list').append('' +
							'<div class="col mb-4">' +
								(BB.price > 0 ? '<a href="' + bb_url + '" target="_blank">' : '<div>') +
									'<div class="card bg-dark' + (BB.price == 0 ? ' addToCart cursor' : '' ) + '" data-id="' + BB.id + '" data-full_name="' + BB.full_name + '" data-name="' + BB.name + '" data-type="' + BB.type + '" data-option="' + BB.option + '" data-date="' + BB.date + '" data-contained="' + BB.contained + '" data-price="' + BB.price + '" data-currency="' + BB.currency + '" data-insurance="' + BB.insurance + '" data-fromshipid="' + BB.upgrade.fromshipid + '" data-toshipid="' + BB.upgrade.toshipid + '" data-toskuid="' + BB.upgrade.toskuid + '">' +
										'<div class="bb_image d-flex">' + ship_image + '</div>' +
										'<div class="card-body p-1 m-0">' +
											'<div class="pb-2">' +
												'<h6 class="m-0">' + BB.name + '</h6>' +
											'</div>' +
											'<div class="d-flex flex-wrap">' +
												label_type + 
												label_option +
												label_assurance + 
												label_price + 
											'</div>' +
										'</div>' +
									'</div>' +
								(BB.price>0?'</a>':'</div>') + 
							'</div>' +
						'');
					});
					
					$(href + ' span > strong.total_price').parent().removeClass('d-none');
					$(href + ' span > strong.total_price').text(numberWithCommas(total_price.toFixed(2)));
					$(href + ' span > strong.currency').text(currency);

					$('#input_search_buyback').removeClass('d-none');

					$('#buyback_search').val('');
					$('#buyback_search').keyup();
					
				}
				else
				{
					buyback_li_a.parent().addClass('d-none');
					$(href + ' .cached_since').removeClass('d-none').find('code').text('Something wen\'t wrong');
				}
			});
		}
	});
}

$(document).ready(function () {
	$(document).on('click', 'div.addToCart', function () {
		addToCart($(this).data('fromshipid'), $(this).data('toshipid'), $(this).data('toskuid'), $(this).data('id'));
	});
	
	$(document).on('mouseover', '#page_BuyBack .buyback_list a', function () {
		$(this).find('.card').removeClass('bg-dark').addClass('bg-thirdary border-highlighted');
	});
	
	$(document).on('mouseout', '#page_BuyBack .buyback_list a', function () {
		$(this).find('.card').removeClass('bg-thirdary border-highlighted').addClass('bg-dark');
	});
	
	$(document).on('click', '#BuyBackRefresh', function () {
		refresh_BB_data('#page_BuyBack', true);
	});
	
	// Search in BB
	$(document).on('keyup', '#buyback_search', function () {

		var search_input = $(this).val().trim().toLowerCase();

		$('.buyback_list .card').attr("data-nb_found", 0).parent().parent().removeClass('d-none');

		keywords = search_input.trim().split(' ');

		$('.buyback_list .card').each(function (i, this_card) {

			var full_name = $(this_card).data('full_name');
			if (full_name != 'null') full_name = full_name.toLowerCase();
			else full_name = '';

			var date = $(this_card).data('date');
			if (date != 'null') date = date.toLowerCase();
			else date = '';
			
			var price = parseInt($(this_card).data('price'));
			if (price == 'null') price = '';
			
			var currency = $(this_card).data('currency');
			if (currency != 'null') currency = currency.toLowerCase();
			else currency = '';
			
			var insurance = $(this_card).data('insurance');
			if (insurance != 'null') insurance = insurance.toLowerCase();
			else insurance = '';
			
			var items = [];
			$(this_card).find('.card-body ul > li').each((index, item) => {
				items.push($(item).text());
			});
			
			items = items.join(',').toLowerCase();

			$(keywords).each(function (index, keyword) {
				if (keyword.length == 0) keywords.splice(index, 1);
				else
				{
					if (keyword == "lti") keyword = "lifetime";
					
					switch (keyword.charAt(0))
					{
						case "<":
							price_searched = keyword.substr(1, keyword.length);
							if (price < price_searched ) {
								// found
								nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;
								$(this_card).attr("data-nb_found", nb_found);
							}
							break;
						case ">":
							price_searched = keyword.substr(1, keyword.length);
							if (price > price_searched ) {
								// found
								nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;
								$(this_card).attr("data-nb_found", nb_found);
							}
							break;
						case "=":
							price_searched = keyword.substr(1, keyword.length);
							if (price == price_searched ) {
								// found
								nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;
								$(this_card).attr("data-nb_found", nb_found);
							}
							break;
						default:
							if (
								full_name.includes(keyword) ||
								date.includes(keyword) ||
								price == keyword ||
								currency.includes(keyword) ||
								insurance.includes(keyword) ||
								items.includes(keyword)
							) {
								// keyword found
								nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;

								$(this_card).attr("data-nb_found", nb_found);
							}
							break;
					}
				}
			});
		});

		$('.buyback_list .card[data-nb_found!="' + keywords.length + '"]').parent().parent().addClass('d-none');

		var found_BB = $('.buyback_list .card[data-nb_found="' + keywords.length + '"]');

		$('#page_BuyBack h1.h2 span').text(' (' + found_BB.length + '/' + $('.buyback_list .card').length + ')');
	});
	
});