function LeftMenu_Click_Telemetry(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		// Get Telemetry information
		chrome.runtime.sendMessage({
			type: 'GetTelemetry',
			LIVE_Token: Rsi_LIVE_Token,
		}, (result) => {
			elem.find('.badge').html('');

			if (result.success == 1 && result.data.length > 0) {

				if (typeof result.data.avg_fps != "undefined") $('#page_Telemetry .avg_fps').text(Math.round(result.data.avg_fps * 100) / 100);
				if (typeof result.data.cpu != "undefined") $('#page_Telemetry .cpu').text(result.data.cpu);
				if (typeof result.data.cpuPerfIdx != "undefined") $('#page_Telemetry .cpuPerfIdx').text(Math.round(result.data.cpuPerfIdx * 100) / 100);
				if (typeof result.data.cpu_use != "undefined") $('#page_Telemetry .sc_avg_use').text(Math.round(result.data.cpu_use.sc_avg_use * 100) / 100);
				if (typeof result.data.cpu_use != "undefined") $('#page_Telemetry .sc_max_use').text(Math.round(result.data.cpu_use.sc_max_use * 100) / 100);
				if (typeof result.data.cpu_use != "undefined") $('#page_Telemetry .sc_min_use').text(Math.round(result.data.cpu_use.sc_min_use * 100) / 100);
				if (typeof result.data.gpu != "undefined") $('#page_Telemetry .gpu').text(result.data.gpu);
				if (typeof result.data.gpuPerfIdx != "undefined") $('#page_Telemetry .gpuPerfIdx').text(Math.round(result.data.gpuPerfIdx * 100) / 100);
				if (typeof result.data.latency != "undefined") $('#page_Telemetry .latency.avg').text(Math.round(result.data.latency.avg * 100) / 100);
				if (typeof result.data.latency != "undefined") $('#page_Telemetry .latency.max').text(Math.round(result.data.latency.max * 100) / 100);
				if (typeof result.data.latency != "undefined") $('#page_Telemetry .latency.min').text(Math.round(result.data.latency.min * 100) / 100);
				if (typeof result.data.load_times != "undefined") $('#page_Telemetry .load_times.avg').text(Math.round(result.data.load_times.avg * 100) / 100);
				if (typeof result.data.load_times != "undefined") $('#page_Telemetry .load_times.max').text(Math.round(result.data.load_times.max * 100) / 100);
				if (typeof result.data.load_times != "undefined") $('#page_Telemetry .load_times.min').text(Math.round(result.data.load_times.min * 100) / 100);
				if (typeof result.data.scrWidth != "undefined" && typeof result.data.scrHeight != "undefined") $('#page_Telemetry .resolution').text(result.data.scrWidth + 'x' + result.data.scrHeight);
				if (typeof result.data.totPhysMem != "undefined") $('#page_Telemetry .totPhysMem').text(humanFileSize(result.data.totPhysMem, false));
			}
		});
	}
}
$( document ).ready(function() {});