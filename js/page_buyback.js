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


function refresh_BB_data(href, refresh)
{
	//$(href + ' .buyback_list').html('<div class="text-center text-secondary mt-4"><i class="fas fa-spinner fa-spin fa-5x"></i></center>');
	$('#BuyBackRefresh').attr('disabled', true).find('i').addClass('fa-spin');
	
	elem_bb_li_a = $('a.nav-link[href="' + href + '"]');
	elem_bb_li_a.find('.badge').html('<i class="fas fa-sync fa-spin"></i>');
	
	$(href + ' .cached_since').removeClass('d-none').find('code').text('in progress...');
	
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
			
			elem_bb_li_a.find('.badge').html(BuyBack.data.BuyBack.length);
			
			var contained;
			var total_price = 0;
			var curency = '';
			
			$(href + ' .buyback_list').html('');
			
			$(BuyBack.data.BuyBack).each(function (i, BB) {
				total_price = total_price + BB.price;

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
				
				if(BB.url !== false) bb_url = BB.url.trim();
				else bb_url = '';
				if (bb_url.length == 0) bb_url = '#';
				
				price = 0;
				if (BB.price > 0) price = BB.price.toFixed(2);
				if (price.includes('.00')) [price] = price.split('.00');
				if (price.length == 0) price = 0;
				
				label_price = '';
				if (price > 0) label_price = '<span class="ml-1 mb-1 badge badge-primary">' + numberWithCommas(price) + ' ' + BB.currency + '</span>';
				
				label_assurance = '';
				if (BB.insurance.length > 0) label_assurance = '<span class="ml-1 mb-1 badge badge-light">' + BB.insurance + '</span>';
				
				label_type = '';
				if (BB.type.length > 0) label_type = '<span class="ml-1 mb-1 badge badge-success">' + BB.type + '</span>';
				
				label_option = '';
				if (BB.option.length > 0) label_option = '<span class="ml-1 mb-1 badge badge-dark">' + capitalizeFirstLetter(BB.option) + '</span>';
				
				$(href + ' .buyback_list').append('' +
					'<div class="col mb-4">' +
						'<a href="' + bb_url + '" target="_blank">' +
							'<div class="card bg-dark" data-id="' + BB.id + '" data-full_name="' + BB.full_name + '" data-name="' + BB.name + '" data-type="' + BB.type + '" data-option="' + BB.option + '" data-date="' + BB.date + '" data-contained="' + BB.contained + '" data-price="' + BB.price + '" data-currency="' + BB.currency + '" data-insurance="' + BB.insurance + '">' +
								'<div class="card-header p-0 p-1 pl-2 m-0">' +
									BB.name +
								'</div>' +  
								'<div class="card-body tex-light p-0">' +
									'<div class="card_image">' +
										'<img src="' + BB.image + '" class="card-img-top" alt="' + BB.contained + '">' +
										'<div class="d-flex flex-wrap text-right">' +
											label_type + 
											label_option +
											label_assurance + 
											label_price + 
										'</div>' +
									'</div>' +
									'<div class="p-1">' +
										contained +
									'</div>' +
								'</div>' +
							'</div>' +
						'</a>' + 
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

$(document).ready(function () {
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
							console.log(price_searched);
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

		$('.buyback_list .col:not(".d-none") .card[data-nb_found!="' + keywords.length + '"]').parent().parent().addClass('d-none');

		var found_BB = $('.buyback_list .col:not(".d-none") .card');


		$('#page_BuyBack h1.h2 span').text(' (' + found_BB.length + '/' + $('.buyback_list .card').length + ')');
	});
	
});