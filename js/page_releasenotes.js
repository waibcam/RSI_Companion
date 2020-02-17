function LeftMenu_Click_ReleaseNotes(elem, href)
{
	if (handle === false) {
		setTimeout( () => {
			LeftMenu_Click(elem);
		}, 250);
	} else {
		// Collecting RSI Companion Release Notes
		chrome.runtime.sendMessage({
			type: 'getReleaseNotes',
		}, (ReleaseNotes) => {
			if (ReleaseNotes.success == 1)
			{										
				$('#page_ReleaseNotes .content > pre').html('');
				
				$(ReleaseNotes.data.info).each((index, line) => {
					$('#page_ReleaseNotes .content > pre').append(line + "\n");
				});
				
				var nb_release = 0;
				$(ReleaseNotes.data.releases).each((index, release) => {
					if (release.date !== false)
					{
						nb_release++;
						$('#page_ReleaseNotes .content > pre').append('\n<span class="text-warning">' + release.version + ' - Released ' + timeSince(release.date) + ':</span>\n');
						$('#page_ReleaseNotes .content > pre').append('------------------------------------\n');
						$(release.features).each((index, feature) => {
							$('#page_ReleaseNotes .content > pre').append(feature + '\n');
						});
					}
				});
				$('a.nav-link[href="#page_ReleaseNotes"]').find('.badge').html(nb_release);
			}
		});
	}
}

$(document).ready(function () {
});