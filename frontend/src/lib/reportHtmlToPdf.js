/**
 * Converte o HTML do relatório VI ALA em Blob PDF (A4).
 * Usa html2canvas + jsPDF — mesmo conteúdo visual do print.
 */
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

function waitForImages(doc, timeoutMs = 8000) {
  const imgs = Array.from(doc.images || []);
  if (!imgs.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = imgs.length;
    const done = () => {
      left -= 1;
      if (left <= 0) resolve();
    };
    const timer = setTimeout(resolve, timeoutMs);
    imgs.forEach((img) => {
      if (img.complete) {
        done();
        return;
      }
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
    Promise.resolve().then(() => {
      if (left <= 0) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * @param {string} htmlContent
 * @returns {Promise<Blob>}
 */
export async function reportHtmlToPdfBlob(htmlContent) {
  const html = String(htmlContent || '');
  if (!html.trim()) throw new Error('HTML do relatório vazio.');

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;left:-12000px;top:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) throw new Error('Não foi possível montar o PDF.');

    doc.open();
    doc.write(html);
    doc.close();

    await waitForImages(doc);
    await new Promise((r) => setTimeout(r, 120));

    const target = doc.body || doc.documentElement;
    const canvas = await html2canvas(target, {
      scale: 1.2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: 794,
      scrollX: 0,
      scrollY: 0
    });

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4',
      compress: true
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.75);

    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'FAST');
    heightLeft -= pageHeight;

    while (heightLeft > 1) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'FAST');
      heightLeft -= pageHeight;
    }

    return pdf.output('blob');
  } finally {
    try {
      iframe.remove();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>} base64 sem prefixo data:
 */
export async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

