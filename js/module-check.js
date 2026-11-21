/**
 * Module fallback check. Classic script, so it still runs where module
 * scripts cannot (a file:// double click), and reveals the banner that
 * explains how to serve the folder. When js/app.js loads normally the
 * flag is set and the banner stays hidden.
 */
window.addEventListener('load', function () {
  window.setTimeout(function () {
    if (!window.__ARMBENCH_LOADED__) {
      var banner = document.getElementById('module-banner');
      if (banner) banner.classList.add('is-visible');
    }
  }, 1200);
});
