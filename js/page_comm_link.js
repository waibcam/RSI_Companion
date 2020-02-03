function LeftMenu_Click_Comm_Link(elem, href)
{
	elem.find('.badge').text(0);
	$(href + ' .content .Comm_Link').html('');
	
	nb_page_max = (Math.max(News.length, max_news_page)) ;

	for (var page = 1; page <= nb_page_max; page++) {

		// News already in cache
		if (typeof News[page] !== 'undefined')
		{
			display_News(News[page]);
		}
		else {
			setTimeout( (page_number) => {
				if (typeof News[page_number] !== 'undefined') {
					display_News(News[page_number]);
				}
				else
				{
					/*
					// Collecting News
					chrome.runtime.sendMessage({
						type: 'getNews',
						Token: Rsi_LIVE_Token,
						page: page_number
					}, (result) => {
						display_News(result);
					});
					*/
				}
			}, 1000, page);
		}
	}
}

var last_page_number;

function display_News(result) {
	if (result.success == 1) {
		//elem.find('.badge').text(parseInt(elem.find('.badge').text()) + $(result.data).length);

		last_page_number = result.page;

		// looking for all organizations of the user
		$(result.data).each(function (i, news) {

			var image_url = "";

			if (news.image.includes("http")) image_url = news.image.substr(5).slice(0, -2);
			else image_url = base_LIVE_Url + news.image.substr(5).slice(0, -2);

			base_LIVE_Url + news.image.substr(5).slice(0, -2);
			
			var href = news.href;
			if (typeof href == "undefined") href = '';

			var article_size = 4 * news.article_size;

			$('#page_Comm_Link .content .Comm_Link').append('' +
				'<div class="col mb-4">' +
					'<a href="' + base_LIVE_Url + href.substr(1) + '" target="_blank">' +
						'<div class="card bg-dark" data-title="' + news.title.toLowerCase() + '" data-type="' + news.type.toLowerCase() + '" data-nb_found="0">' +
							'<div class="card-header p-1">' +
								'<span class="badge badge-primary">' + capitalizeFirstLetter(news.type) + '</span> ' +
								'' + news.title + '' +
							'</div>' +
							'<img src="' + image_url + '" class="card-img-top" alt="' + news.title + '">' +
							'<div class="card-body p-2">' +
								'<p class="card-text m-0">' + news.time_ago + '</p>' +
								'<p class="card-text text-right"><small>' + news.comments + ' comment' + (news.comments > 1 ? 's' : '') + '</small></p>' +
							'</div>' +
						'</div>' +
					'</a>' +
				'</div>' +
				'');
		});
	}
	
	$('a.nav-link[href="#page_Comm_Link"]').find('.badge').text($('.Comm_Link .col').length);
	$('#news_search').keyup();
}

var news_loading = false;

$(document).ready(function () {
	
	$(document).on('mouseover', '#page_Comm_Link .Comm_Link a', function () {
		$(this).find('.card').removeClass('bg-dark').addClass('bg-thirdary border-highlighted');
	});
	
	$(document).on('mouseout', '#page_Comm_Link .Comm_Link a', function () {
		$(this).find('.card').removeClass('bg-thirdary border-highlighted').addClass('bg-dark');
	});
	
	// Infinit Loading
	$(window).scroll(function () {
		
		triggered_from_bottom = 300; // px
		
		if (!$('#page_Comm_Link').hasClass('d-none') && $(window).scrollTop() + $(window).outerHeight() >= $(document).height() - triggered_from_bottom) {
			
			if (!news_loading)
			{
				news_loading = true;
				
				page = last_page_number + 1;
				
				if (typeof News[page] != "undefined")
				{
					display_News(News[page]);
					news_loading = false;
				}
				else
				{
					chrome.runtime.sendMessage({
						type: 'getNews',
						Token: Rsi_LIVE_Token,
						page: page,
					}, (news_result) => {
						
						if (typeof news_result != "undefined")
						{
							News[news_result.page] = news_result;
							display_News(news_result);
							news_loading = false;
						}
					});
				}
				
				
			}
		}
	}); 
	
	$(document).on('keyup', '#news_search', function () {
		var search_input = $(this).val().trim().toLowerCase();
		var keywords = search_input.trim().split(' ');
		
		$('.Comm_Link .card').attr("data-nb_found", 0).parent().parent().removeClass('d-none');
		
		$('.Comm_Link .card').each(function (i, this_card) {
			
			var title = $(this_card).data('title');
			if (title != 'null') title = title.toLowerCase();
			else title = '';
			
			var type = $(this_card).data('type');
			if (type != 'null') type = type.toLowerCase();
			else type = '';
			
			$(keywords).each(function (index, keyword) {
				if (keyword.length == 0) keywords.splice(index, 1);
				else if (title.includes(keyword) ||	type.includes(keyword))
				{
					// keyword found
					nb_found = parseInt($(this_card).attr("data-nb_found")) + 1;

					$(this_card).attr("data-nb_found", nb_found);
				}

			});
		});
		
		$('.Comm_Link .col:not(".d-none") .card[data-nb_found!="' + keywords.length + '"]').parent().parent().addClass('d-none');

		var found = $('.Comm_Link .col:not(".d-none") .card');

		$('#page_Comm_Link h1.h2 span').text(' (' + found.length + '/' + $('.Comm_Link .card').length + ')');
		
	});
});