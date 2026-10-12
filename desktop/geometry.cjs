const PANEL_SIZE = { width: 360 };
const TAB_SIZE = { width: 40, height: 96 };
const GAP = 0;
function clampBounds(bounds, area) {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height };
}
function dockBounds(main, area, expanded) {
  const width = expanded ? PANEL_SIZE.width : TAB_SIZE.width;
  const fitted = clampBounds({ ...main, width: Math.min(main.width, area.width - width - GAP) },
    { ...area, width: area.width - width - GAP });
  return { main: fitted, assistant: { x: fitted.x + fitted.width + GAP,
    y: expanded ? fitted.y : fitted.y + Math.min(72, Math.max(0, fitted.height - TAB_SIZE.height)),
    width, height: expanded ? fitted.height : Math.min(TAB_SIZE.height, fitted.height) } };
}
module.exports = { PANEL_SIZE, TAB_SIZE, GAP, clampBounds, dockBounds };
