// QR code as an SVG string. Uses qrcode's core + SVG renderer directly so it also bundles for Workers.
import QRCode from 'qrcode/lib/core/qrcode.js';
import SvgTag from 'qrcode/lib/renderer/svg-tag.js';

export function qrSvg(text) {
  text = String(text || '');
  if (!/^https?:\/\//.test(text) || text.length > 300) return null;
  return SvgTag.render(QRCode.create(text, {}), { margin: 1 });
}
