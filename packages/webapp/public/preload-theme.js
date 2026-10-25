// Loaded synchronously before rendering; also used by runtime controls.
(function () {
  var preference = 'light';
  try {
    preference = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
  } catch (_) {
    // Storage restrictions must not prevent application boot.
  }

  function apply() {
    var dark =
      preference === 'dark' &&
      !/^\/payment(?:\/|$)/.test(window.location.pathname);
    document.documentElement.classList.toggle('bp4-dark', dark);
    if (document.body) document.body.classList.toggle('bp4-dark', dark);
  }

  window.legaTheme = {
    get: function () {
      return preference;
    },
    apply: apply,
    set: function (theme) {
      preference = theme === 'dark' ? 'dark' : 'light';
      try {
        localStorage.setItem('theme', preference);
      } catch (_) {}
      apply();
    },
  };
  apply();
})();
