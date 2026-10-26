try {
  if (sessionStorage.getItem('boot-seen')) document.documentElement.dataset.boot = 'done';
  else sessionStorage.setItem('boot-seen', '1');
} catch (e) {}
