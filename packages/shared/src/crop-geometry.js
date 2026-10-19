/**
 * @fileoverview Pure geometry calculation for Single-Capture Multi-Crop.
 * Guarantees zero black borders, zero out-of-bounds source rectangles, and exact DPR/zoom scaling
 * across Chrome, Arc, and Edge viewports.
 */

/**
 * Compute clamped CSS crop box and physical pixel source/destination coordinates.
 *
 * @param {{
 *   rect: { x: number, y: number, width: number, height: number },
 *   markerPoint: { x: number, y: number }
 * }} annotation
 * @param {{
 *   viewportWidth: number,
 *   viewportHeight: number,
 *   imageWidth: number,
 *   imageHeight: number,
 *   paddingCssPx?: number,
 *   maxDimension?: number,
 *   minCropCssPx?: number
 * }} viewport
 * @returns {{
 *   sx: number,
 *   sy: number,
 *   sw: number,
 *   sh: number,
 *   outW: number,
 *   outH: number,
 *   scaleX: number,
 *   scaleY: number,
 *   cropViewportRect: { x: number, y: number, width: number, height: number }
 * }}
 */
export function computeSafeCropGeometry(
  annotation,
  {
    viewportWidth,
    viewportHeight,
    imageWidth,
    imageHeight,
    paddingCssPx = 32,
    maxDimension = 1024,
    minCropCssPx = 16,
  }
) {
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  const imgW = Math.max(1, imageWidth);
  const imgH = Math.max(1, imageHeight);

  const scaleX = imgW / vw;
  const scaleY = imgH / vh;

  // 24x24 marker pin with 2px white ring => 28x28 box around markerPoint
  const markerBox = {
    x: annotation.markerPoint.x - 14,
    y: annotation.markerPoint.y - 14,
    width: 28,
    height: 28,
  };

  let minX = Math.min(annotation.rect.x, markerBox.x) - paddingCssPx;
  let minY = Math.min(annotation.rect.y, markerBox.y) - paddingCssPx;
  let maxX =
    Math.max(annotation.rect.x + annotation.rect.width, markerBox.x + markerBox.width) +
    paddingCssPx;
  let maxY =
    Math.max(annotation.rect.y + annotation.rect.height, markerBox.y + markerBox.height) +
    paddingCssPx;

  // Clamp strictly to visible CSS viewport [0, vw] x [0, vh]
  minX = Math.max(0, Math.min(vw, minX));
  maxX = Math.max(0, Math.min(vw, maxX));
  minY = Math.max(0, Math.min(vh, minY));
  maxY = Math.max(0, Math.min(vh, maxY));

  // Ensure minimum CSS crop size without overflowing viewport bounds (prevents right/bottom black edge)
  const targetMinW = Math.min(vw, minCropCssPx);
  if (maxX - minX < targetMinW) {
    if (minX + targetMinW <= vw) {
      maxX = minX + targetMinW;
    } else {
      maxX = vw;
      minX = Math.max(0, vw - targetMinW);
    }
  }

  const targetMinH = Math.min(vh, minCropCssPx);
  if (maxY - minY < targetMinH) {
    if (minY + targetMinH <= vh) {
      maxY = minY + targetMinH;
    } else {
      maxY = vh;
      minY = Math.max(0, vh - targetMinH);
    }
  }

  const cropCssW = maxX - minX;
  const cropCssH = maxY - minY;

  // Map start/end edges directly to physical image pixels so sx + sw <= imgW is strictly preserved
  const sx = Math.max(0, Math.min(imgW - 1, Math.round(minX * scaleX)));
  const sy = Math.max(0, Math.min(imgH - 1, Math.round(minY * scaleY)));
  const ex = Math.max(sx + 1, Math.min(imgW, Math.round(maxX * scaleX)));
  const ey = Math.max(sy + 1, Math.min(imgH, Math.round(maxY * scaleY)));

  const sw = ex - sx;
  const sh = ey - sy;

  let outW = sw;
  let outH = sh;
  const maxSide = Math.max(outW, outH);
  if (maxSide > maxDimension) {
    const ratio = maxDimension / maxSide;
    outW = Math.max(1, Math.round(outW * ratio));
    outH = Math.max(1, Math.round(outH * ratio));
  }

  return {
    sx,
    sy,
    sw,
    sh,
    outW,
    outH,
    scaleX,
    scaleY,
    cropViewportRect: {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(cropCssW),
      height: Math.round(cropCssH),
    },
  };
}
