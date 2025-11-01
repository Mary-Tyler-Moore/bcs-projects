// issues-time.js

export function getReportTimestamp() {
  const now = new Date();
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(now);
}

export function mountLiveReportClock(el) {
  if (!el) return () => {};
  const update = () => {
    el.textContent = 'Issues Report — ' + getReportTimestamp();
  };
  update();
  // Update every 30s
  const timer = setInterval(update, 30_000);
  return () => clearInterval(timer);
}
