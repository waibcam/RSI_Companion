var AppTitle = '';

$(document).ready(function () {
	CheckConnection(true, true, 'index.js');
	
	$('.ptu_status > a').attr('href', base_PTU_Url);

	// Click on Navbar
	$(document).on('click', 'nav.sidebar ul > li > a', function () {
		LeftMenu_Click($(this));
	});

	$('[data-toggle="popover"]').popover({
		template: '<div class="popover" role="tooltip"><div class="arrow"></div><h3 class="popover-header"></h3><div class="popover-body"></div></div>'
	});
	
	
	var hash = window.location.hash;
	if (hash.startsWith("#")) var elem = $('nav.sidebar ul > li > a[href="' + hash + '"]');
								
	// open first element in the menu if nothing is has, eg "Comm-Link"
	if (typeof elem === "undefined") elem = $('nav.sidebar ul > li > a:eq(0)');
	
	if (typeof elem !== "undefined") LeftMenu_Click(elem);
	
	
	chrome.runtime.sendMessage({type: 'GetAppTitle'}, function(result){		
		AppTitle  = result.AppTitle;
		AppSmallTitle  = result.AppSmallTitle;
		AppVersion  = result.AppVersion;
		
		$('nav a.navbar-brand span').text(AppSmallTitle + ' (v'+AppVersion+')');
		$('#cnx_status h5.card-title').text(AppTitle);
		
		document.title = AppTitle;
	});
	
	chrome.runtime.sendMessage({type: 'getCrowdfundStats'}, function(result){		
		$('#fans').text(numberWithCommas(result.data.fans));
		
		
		var funds = parseInt(result.data.funds);
		funds = (funds-(funds%100))/100;
		$('#funds').text("$" + numberWithCommas(funds));
	});	
	
	$(document).on('click', '.send_report', function () {
		var button = $(this);
		chrome.runtime.sendMessage({
			type: 'sendReport',
			report_type: button.data('report_type'),
			report_data: button.data('report_data')
		}, function(result){
			$('button[data-target="#' + button.data('report_type') + '"]').remove();
		});
	});

});


