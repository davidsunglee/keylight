// Runs before first paint so a picked theme never flashes the default.
try {
  const picked = localStorage.getItem("fathom-theme");
  if (picked) document.documentElement.dataset.theme = picked;
} catch {
  // Storage unavailable (private browsing): stay on Auto.
}
