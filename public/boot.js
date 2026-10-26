// Start-up guard (a plain script, loaded before the app). If the app can't start in this browser (an old phone,
// a script that failed to load, an error while drawing the first screen), the page would stay blank, because
// the app's screen is hidden until it is ready. Instead, after a few seconds, show what went wrong and how to
// report it.
(function () {
  var errors = [];
  function note(msg) { if (errors.length < 5) errors.push(String(msg).slice(0, 300)); }
  window.addEventListener('error', function (e) {
    note(e.message ? e.message + (e.filename ? ' (' + e.filename.replace(location.origin, '') + ':' + e.lineno + ')' : '')
      : 'could not load ' + ((e.target && (e.target.src || e.target.href)) || 'a file'));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { note((e.reason && e.reason.message) || e.reason); });
  window.zaccBootError = note; // the app reports errors from drawing its first screen here
  function check() {
    var app = document.getElementById('app');
    if (!app || !app.hasAttribute('v-cloak')) return; // started fine
    var box = document.createElement('div');
    box.className = 'boot-error';
    var h = document.createElement('h1'); h.textContent = 'zAccountant could not start in this browser';
    var p = document.createElement('p');
    p.textContent = 'Please take a screenshot of this page and send it to us (or press Beta feedback on another device). '
      + 'Updating the phone or browser, or closing and reopening the page, often fixes it.';
    var pre = document.createElement('pre');
    pre.textContent = (errors.length ? errors.join('\n') : 'No error was reported; the app did not finish starting.')
      + '\n\nBrowser: ' + navigator.userAgent;
    var a = document.createElement('a'); a.href = location.pathname; a.textContent = 'Try again';
    box.appendChild(h); box.appendChild(p); box.appendChild(pre); box.appendChild(a);
    document.body.appendChild(box);
  }
  window.addEventListener('load', function () { setTimeout(check, 6000); });
})();
