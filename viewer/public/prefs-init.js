// Runs before first paint so what was picked on this device never flashes the default.
try {
  const root = document.documentElement;
  const theme = localStorage.getItem("fathom-theme");
  if (theme) root.dataset.theme = theme;
  if (localStorage.getItem("fathom-sidebar") === "collapsed") root.dataset.sidebar = "collapsed";
  const width = Number(localStorage.getItem("fathom-sidebar-width"));
  if (width) root.style.setProperty("--sidebar-width", `${width}px`);
} catch {
  // Storage unavailable (private browsing): stay on the defaults.
}
