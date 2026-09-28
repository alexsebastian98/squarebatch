/**
 * SquareBatch — Privacy-First Browser-Only Photo Squaring
 * 100% Client-Side Canvas Engine. Zero tracking, zero uploads.
 */

// ============================================================================
// Application State
// ============================================================================
const state = {
  photos: [],            // Array of PhotoItem
  activePhotoId: null,   // ID of photo shown in live preview
  isProcessing: false,   // True when batch process is running
  cancelRequested: false,// Flag to break batch processing loop
  settings: {
    outputSize: 2000,    // 200 - 8000 px
    paddingPercent: 10,  // 0 - 40 %
    bgColor: '#FFFFFF',  // Hex color
    format: 'image/jpeg',// 'image/jpeg' | 'image/png' | 'image/webp'
    quality: 92,         // 50 - 100
    suffix: '_square',   // String
    chunkSize: 10,       // 5, 10, 20
    showGuide: false     // boolean
  }
};

// Cached active ImageBitmap for preview to avoid re-decoding while dragging sliders
let cachedPreviewBitmap = null;
let cachedPreviewPhotoId = null;
let previewRenderRafId = null;

// ============================================================================
// DOM Element References
// ============================================================================
const dom = {
  // Preview
  previewCanvas: document.getElementById('previewCanvas'),
  previewCanvasWrapper: document.getElementById('previewCanvasWrapper'),
  previewPlaceholder: document.getElementById('previewPlaceholder'),
  previewGuideOverlay: document.getElementById('previewGuideOverlay'),
  previewFilename: document.getElementById('previewFilename'),
  previewDimensions: document.getElementById('previewDimensions'),
  previewIndexCounter: document.getElementById('previewIndexCounter'),
  prevPhotoBtn: document.getElementById('prevPhotoBtn'),
  nextPhotoBtn: document.getElementById('nextPhotoBtn'),
  toggleGuideBtn: document.getElementById('toggleGuideBtn'),
  toggleZoomBtn: document.getElementById('toggleZoomBtn'),
  zoomToggleText: document.getElementById('zoomToggleText'),

  // Controls
  outputSizeInput: document.getElementById('outputSizeInput'),
  aspectRatioHint: document.getElementById('aspectRatioHint'),
  sizePills: document.querySelectorAll('.pill-btn[data-size]'),
  paddingSlider: document.getElementById('paddingSlider'),
  paddingNumber: document.getElementById('paddingNumber'),
  paddingPxHint: document.getElementById('paddingPxHint'),
  bgColorPicker: document.getElementById('bgColorPicker'),
  bgColorHex: document.getElementById('bgColorHex'),
  eyeDropperBtn: document.getElementById('eyeDropperBtn'),
  swatchButtons: document.querySelectorAll('.swatch-btn'),
  formatButtons: document.querySelectorAll('.segmented-btn[data-format]'),
  qualityControlGroup: document.getElementById('qualityControlGroup'),
  qualitySlider: document.getElementById('qualitySlider'),
  qualityNumber: document.getElementById('qualityNumber'),
  qualityValDisplay: document.getElementById('qualityValDisplay'),
  suffixInput: document.getElementById('suffixInput'),
  suffixPreview: document.getElementById('suffixPreview'),
  chunkSizeSelect: document.getElementById('chunkSizeSelect'),

  // Presets
  presetInstagram: document.getElementById('presetInstagram'),
  presetLossless: document.getElementById('presetLossless'),
  presetDarkroom: document.getElementById('presetDarkroom'),
  presetStudioIvory: document.getElementById('presetStudioIvory'),

  // Drop & Ingestion
  dropZone: document.getElementById('dropZone'),
  windowDragOverlay: document.getElementById('windowDragOverlay'),
  fileInput: document.getElementById('fileInput'),
  folderInput: document.getElementById('folderInput'),
  selectFilesBtn: document.getElementById('selectFilesBtn'),
  selectFolderBtn: document.getElementById('selectFolderBtn'),
  largeBatchAlert: document.getElementById('largeBatchAlert'),
  largeBatchAlertText: document.getElementById('largeBatchAlertText'),

  // Batch List & Toolbar
  batchToolbar: document.getElementById('batchToolbar'),
  batchCountText: document.getElementById('batchCountText'),
  batchSizeText: document.getElementById('batchSizeText'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  retryFailedBtn: document.getElementById('retryFailedBtn'),
  thumbnailGrid: document.getElementById('thumbnailGrid'),

  // Sticky Bottom Bar
  bottomBar: document.getElementById('bottomBar'),
  progressStatusLabel: document.getElementById('progressStatusLabel'),
  progressCounter: document.getElementById('progressCounter'),
  progressBarFill: document.getElementById('progressBarFill'),
  processAllBtn: document.getElementById('processAllBtn'),
  processBtnText: document.getElementById('processBtnText'),
  saveZipBtn: document.getElementById('saveZipBtn'),
  zipBtnText: document.getElementById('zipBtnText')
};

// ============================================================================
// Core Squaring Math & Safe Canvas Rendering
// ============================================================================

/**
 * Calculates inner bounding box and centering coordinates
 * preserving aspect ratio without crop or distortion.
 */
function calculateSquareLayout(outputSize, paddingPercent, imgWidth, imgHeight) {
  const paddingRatio = paddingPercent / 100;
  // Inner max bounding box: outputSize minus left+right or top+bottom padding
  const innerSize = outputSize * (1 - (2 * paddingRatio));
  const aspect = imgWidth / imgHeight;

  let drawW, drawH;
  if (aspect >= 1) {
    // Landscape or square
    drawW = innerSize;
    drawH = innerSize / aspect;
  } else {
    // Portrait
    drawH = innerSize;
    drawW = innerSize * aspect;
  }

  // Exact center inside the square canvas
  const drawX = (outputSize - drawW) / 2;
  const drawY = (outputSize - drawH) / 2;

  return {
    outputSize,
    innerSize,
    drawX,
    drawY,
    drawW,
    drawH,
    paddingPx: (outputSize - innerSize) / 2
  };
}

/**
 * Decodes an image file safely respecting EXIF orientation.
 * Returns an ImageBitmap or HTMLImageElement.
 */
async function decodeImage(file) {
  if (typeof window.createImageBitmap === 'function') {
    try {
      // Respect EXIF orientation from phone/camera headers
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        // Fall back to Image element
      }
    }
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Image failed to decode: ' + (err?.message || 'Unsupported format')));
    };
    img.src = objectUrl;
  });
}

/**
 * Creates a lightweight (~160px) thumbnail dataURL to conserve memory.
 * Decoded bitmaps are immediately closed to free RAM.
 */
async function generateThumbnail(file) {
  try {
    let bitmap;
    if (typeof window.createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: 160,
          resizeHeight: 160,
          resizeQuality: 'low'
        });
      } catch {
        bitmap = await createImageBitmap(file);
      }
    }

    const thumbCanvas = document.createElement('canvas');
    const thumbCtx = thumbCanvas.getContext('2d', { alpha: false });
    const targetDim = 140;
    thumbCanvas.width = targetDim;
    thumbCanvas.height = targetDim;

    thumbCtx.fillStyle = '#14151a';
    thumbCtx.fillRect(0, 0, targetDim, targetDim);

    let origW = 0, origH = 0;

    if (bitmap) {
      origW = bitmap.width;
      origH = bitmap.height;
      const aspect = bitmap.width / bitmap.height;
      let dw, dh;
      if (aspect >= 1) {
        dw = targetDim;
        dh = targetDim / aspect;
      } else {
        dh = targetDim;
        dw = targetDim * aspect;
      }
      const dx = (targetDim - dw) / 2;
      const dy = (targetDim - dh) / 2;
      thumbCtx.drawImage(bitmap, dx, dy, dw, dh);
      bitmap.close(); // Clean release
    } else {
      // Fallback via Image element
      const img = await decodeImage(file);
      origW = img.width;
      origH = img.height;
      const aspect = img.width / img.height;
      let dw, dh;
      if (aspect >= 1) {
        dw = targetDim;
        dh = targetDim / aspect;
      } else {
        dh = targetDim;
        dw = targetDim * aspect;
      }
      const dx = (targetDim - dw) / 2;
      const dy = (targetDim - dh) / 2;
      thumbCtx.drawImage(img, dx, dy, dw, dh);
      if (img.close) img.close();
    }

    const dataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
    return { dataUrl, width: origW, height: origH };
  } catch (err) {
    console.warn('Thumbnail generation fallback:', err);
    return { dataUrl: '', width: 0, height: 0 };
  }
}

// ============================================================================
// Live Preview Rendering (Throttled via requestAnimationFrame)
// ============================================================================

function schedulePreviewRender() {
  if (previewRenderRafId) {
    cancelAnimationFrame(previewRenderRafId);
  }
  previewRenderRafId = requestAnimationFrame(() => {
    renderLivePreview();
  });
}

async function renderLivePreview() {
  const activePhoto = state.photos.find(p => p.id === state.activePhotoId);

  if (!activePhoto) {
    dom.previewCanvasWrapper.style.display = 'none';
    dom.previewPlaceholder.style.display = 'flex';
    dom.previewFilename.textContent = 'No photo loaded';
    dom.previewDimensions.textContent = '—';
    dom.prevPhotoBtn.disabled = true;
    dom.nextPhotoBtn.disabled = true;
    dom.previewIndexCounter.textContent = '0 / 0';
    return;
  }

  dom.previewPlaceholder.style.display = 'none';
  dom.previewCanvasWrapper.style.display = 'inline-flex';

  const currentIndex = state.photos.findIndex(p => p.id === activePhoto.id);
  dom.previewIndexCounter.textContent = `${currentIndex + 1} / ${state.photos.length}`;
  dom.prevPhotoBtn.disabled = currentIndex <= 0;
  dom.nextPhotoBtn.disabled = currentIndex >= state.photos.length - 1;
  dom.previewFilename.textContent = activePhoto.name;

  // Retrieve or decode cached bitmap for the active photo
  if (cachedPreviewPhotoId !== activePhoto.id || !cachedPreviewBitmap) {
    if (cachedPreviewBitmap && cachedPreviewBitmap.close) {
      cachedPreviewBitmap.close();
    }
    cachedPreviewBitmap = null;
    try {
      cachedPreviewBitmap = await decodeImage(activePhoto.file);
      cachedPreviewPhotoId = activePhoto.id;
      // Update dimensions if not known
      if (activePhoto.width === 0 && cachedPreviewBitmap) {
        activePhoto.width = cachedPreviewBitmap.width;
        activePhoto.height = cachedPreviewBitmap.height;
        updateCardMeta(activePhoto);
      }
    } catch (err) {
      console.error('Failed to decode preview photo:', err);
      dom.previewFilename.textContent = `${activePhoto.name} (Decode error)`;
      return;
    }
  }

  if (!cachedPreviewBitmap) return;

  const imgW = cachedPreviewBitmap.width;
  const imgH = cachedPreviewBitmap.height;

  dom.previewDimensions.textContent = `${imgW}×${imgH} → ${state.settings.outputSize}×${state.settings.outputSize}`;

  // Preview resolution capped at max 900px for high performance
  const maxDisplayDim = Math.min(state.settings.outputSize, 900);
  const scale = maxDisplayDim / state.settings.outputSize;

  const canvas = dom.previewCanvas;
  canvas.width = maxDisplayDim;
  canvas.height = maxDisplayDim;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Fill background
  ctx.fillStyle = state.settings.bgColor;
  ctx.fillRect(0, 0, maxDisplayDim, maxDisplayDim);

  // Layout math
  const layout = calculateSquareLayout(
    state.settings.outputSize,
    state.settings.paddingPercent,
    imgW,
    imgH
  );

  // Scaled coordinates on preview canvas
  const pDrawX = layout.drawX * scale;
  const pDrawY = layout.drawY * scale;
  const pDrawW = layout.drawW * scale;
  const pDrawH = layout.drawH * scale;

  // Draw image
  ctx.drawImage(cachedPreviewBitmap, pDrawX, pDrawY, pDrawW, pDrawH);

  // Update padding guide overlay if enabled
  updateGuideOverlay(layout, scale);
}

function updateGuideOverlay(layout, scale) {
  const overlay = dom.previewGuideOverlay;
  if (!state.settings.showGuide || !layout) {
    overlay.classList.remove('visible');
    return;
  }

  const pPadPx = layout.paddingPx * scale;
  const pInner = layout.innerSize * scale;

  overlay.style.left = `${pPadPx}px`;
  overlay.style.top = `${pPadPx}px`;
  overlay.style.width = `${pInner}px`;
  overlay.style.height = `${pInner}px`;
  overlay.classList.add('visible');
}

// ============================================================================
// Single Photo Processing Function
// ============================================================================

/**
 * Processes a single photo into the target format and returns a Blob.
 * Cleans up bitmaps immediately to avoid memory leaks.
 */
async function processSinglePhoto(photo) {
  let bitmap = null;
  let canvas = null;
  try {
    bitmap = await decodeImage(photo.file);
    const imgW = bitmap.width;
    const imgH = bitmap.height;

    const outSize = state.settings.outputSize;
    canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;

    const ctx = canvas.getContext('2d', { alpha: state.settings.format === 'image/png' });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Fill chosen background color
    ctx.fillStyle = state.settings.bgColor;
    ctx.fillRect(0, 0, outSize, outSize);

    // Compute square padding & centered coordinates
    const layout = calculateSquareLayout(outSize, state.settings.paddingPercent, imgW, imgH);
    ctx.drawImage(bitmap, layout.drawX, layout.drawY, layout.drawW, layout.drawH);

    // Convert to Blob
    const mime = state.settings.format;
    const quality = mime === 'image/png' ? undefined : (state.settings.quality / 100);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Canvas export produced null blob'));
      }, mime, quality);
    });

    return blob;
  } finally {
    if (bitmap && bitmap.close) {
      bitmap.close();
    }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1; // Release canvas backing store
    }
  }
}

// ============================================================================
// Batch Ingestion (Files & Recursive Folders)
// ============================================================================

const VALID_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function isImageFile(file) {
  if (!file) return false;
  if (file.type && (file.type.startsWith('image/jpeg') || file.type.startsWith('image/png') || file.type.startsWith('image/webp'))) {
    return true;
  }
  const name = file.name.toLowerCase();
  return VALID_IMAGE_EXTS.some(ext => name.endsWith(ext));
}

/**
 * Handles incoming File objects, creates items, and populates grid
 */
async function addFilesToBatch(files) {
  const validFiles = Array.from(files).filter(isImageFile);

  if (validFiles.length === 0) return;

  for (const file of validFiles) {
    const id = 'photo_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
    const photoItem = {
      id,
      file,
      name: file.name,
      size: file.size,
      type: file.type || 'image/jpeg',
      width: 0,
      height: 0,
      thumbUrl: '',
      status: 'queued',
      error: null,
      processedBlob: null,
      processedUrl: null
    };

    state.photos.push(photoItem);
    renderThumbnailCard(photoItem);

    // Generate thumbnail in background
    generateThumbnail(file).then(({ dataUrl, width, height }) => {
      photoItem.thumbUrl = dataUrl;
      photoItem.width = width;
      photoItem.height = height;
      updateCardThumb(photoItem);
    });
  }

  // Set active photo if none selected
  if (!state.activePhotoId && state.photos.length > 0) {
    setActivePhoto(state.photos[0].id);
  }

  updateBatchUI();
  schedulePreviewRender();
}

/**
 * Recursive folder drag-and-drop traversal using WebKit FileSystem API
 */
async function handleDropEvent(event) {
  event.preventDefault();
  dom.dropZone.classList.remove('dragover');

  const items = event.dataTransfer?.items;
  if (!items) {
    if (event.dataTransfer?.files) {
      addFilesToBatch(event.dataTransfer.files);
    }
    return;
  }

  const collectedFiles = [];

  async function traverseEntry(entry) {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file((file) => {
          if (isImageFile(file)) collectedFiles.push(file);
          resolve();
        }, () => resolve());
      });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const readEntries = () => {
        return new Promise((resolve) => {
          dirReader.readEntries(async (entries) => {
            if (!entries || entries.length === 0) {
              resolve();
            } else {
              for (const childEntry of entries) {
                await traverseEntry(childEntry);
              }
              // Keep reading until directory is exhausted per spec
              await readEntries();
              resolve();
            }
          }, () => resolve());
        });
      };
      await readEntries();
    }
  }

  const entries = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    } else if (item.getAsFile) {
      const f = item.getAsFile();
      if (f && isImageFile(f)) collectedFiles.push(f);
    }
  }

  for (const entry of entries) {
    await traverseEntry(entry);
  }

  if (collectedFiles.length > 0) {
    addFilesToBatch(collectedFiles);
  }
}

// ============================================================================
// Batch Grid Rendering & Management
// ============================================================================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function renderThumbnailCard(photo) {
  const card = document.createElement('div');
  card.className = `thumb-card ${photo.id === state.activePhotoId ? 'active-preview' : ''}`;
  card.id = `card_${photo.id}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Select ${photo.name} for preview`);

  card.innerHTML = `
    <div class="thumb-image-container">
      <img class="thumb-img" id="img_${photo.id}" src="${photo.thumbUrl || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='}" alt="${photo.name}" loading="lazy">
      <button type="button" class="thumb-remove-btn" data-id="${photo.id}" title="Remove photo" aria-label="Remove photo">✕</button>
      <span class="thumb-status-badge ${photo.status}" id="status_${photo.id}">${photo.status}</span>
    </div>
    <div class="thumb-meta">
      <span class="thumb-filename" title="${photo.name}">${photo.name}</span>
      <div class="thumb-dimensions">
        <span id="dim_${photo.id}">${photo.width ? `${photo.width}×${photo.height}` : '...'}</span>
        <span>${formatBytes(photo.size)}</span>
      </div>
      <div class="thumb-actions" id="actions_${photo.id}">
        ${photo.status === 'done' ? `
          <button type="button" class="thumb-btn-download" data-download-id="${photo.id}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Save
          </button>
        ` : ''}
      </div>
    </div>
  `;

  // Select card for live preview
  card.addEventListener('click', (e) => {
    if (e.target.closest('.thumb-remove-btn') || e.target.closest('.thumb-btn-download')) {
      return;
    }
    setActivePhoto(photo.id);
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setActivePhoto(photo.id);
    }
  });

  // Remove button handler
  const removeBtn = card.querySelector('.thumb-remove-btn');
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removePhoto(photo.id);
  });

  dom.thumbnailGrid.appendChild(card);
}

function updateCardThumb(photo) {
  const imgEl = document.getElementById(`img_${photo.id}`);
  if (imgEl && photo.thumbUrl) {
    imgEl.src = photo.thumbUrl;
  }
  updateCardMeta(photo);
}

function updateCardMeta(photo) {
  const dimEl = document.getElementById(`dim_${photo.id}`);
  if (dimEl && photo.width > 0) {
    dimEl.textContent = `${photo.width}×${photo.height}`;
  }
}

function updateCardStatus(photo) {
  const badge = document.getElementById(`status_${photo.id}`);
  if (badge) {
    badge.className = `thumb-status-badge ${photo.status}`;
    badge.textContent = photo.status;
  }
  const actionsEl = document.getElementById(`actions_${photo.id}`);
  if (actionsEl) {
    if (photo.status === 'done') {
      actionsEl.innerHTML = `
        <button type="button" class="thumb-btn-download" data-download-id="${photo.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Save
        </button>
      `;
      const dlBtn = actionsEl.querySelector('[data-download-id]');
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSinglePhoto(photo);
      });
    } else {
      actionsEl.innerHTML = '';
    }
  }
}

function removePhoto(id) {
  const index = state.photos.findIndex(p => p.id === id);
  if (index === -1) return;

  const [removed] = state.photos.splice(index, 1);
  if (removed.processedUrl) {
    URL.revokeObjectURL(removed.processedUrl);
  }

  const card = document.getElementById(`card_${id}`);
  if (card) card.remove();

  if (state.activePhotoId === id) {
    if (cachedPreviewBitmap && cachedPreviewBitmap.close) {
      cachedPreviewBitmap.close();
      cachedPreviewBitmap = null;
    }
    cachedPreviewPhotoId = null;
    if (state.photos.length > 0) {
      const nextIndex = Math.min(index, state.photos.length - 1);
      setActivePhoto(state.photos[nextIndex].id);
    } else {
      state.activePhotoId = null;
      schedulePreviewRender();
    }
  }

  updateBatchUI();
}

function clearAllPhotos() {
  if (state.photos.length === 0) return;
  if (!confirm(`Clear all ${state.photos.length} photos from batch?`)) return;

  // Revoke object URLs and close bitmaps
  for (const p of state.photos) {
    if (p.processedUrl) URL.revokeObjectURL(p.processedUrl);
  }
  if (cachedPreviewBitmap && cachedPreviewBitmap.close) {
    cachedPreviewBitmap.close();
    cachedPreviewBitmap = null;
  }
  cachedPreviewPhotoId = null;

  state.photos = [];
  state.activePhotoId = null;
  dom.thumbnailGrid.innerHTML = '';
  updateBatchUI();
  schedulePreviewRender();
}

function setActivePhoto(id) {
  if (state.activePhotoId === id) return;
  state.activePhotoId = id;

  // Highlight card in grid
  document.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('active-preview'));
  const card = document.getElementById(`card_${id}`);
  if (card) {
    card.classList.add('active-preview');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  schedulePreviewRender();
}

function updateBatchUI() {
  const total = state.photos.length;
  const processedCount = state.photos.filter(p => p.status === 'done').length;

  if (total > 0) {
    dom.batchToolbar.style.display = 'flex';
    dom.bottomBar.classList.remove('hidden');

    const totalBytes = state.photos.reduce((sum, p) => sum + p.size, 0);
    dom.batchCountText.textContent = `${total} Photo${total === 1 ? '' : 's'}`;
    dom.batchSizeText.textContent = `${formatBytes(totalBytes)} total`;

    // Large batch warning (if > 60 photos or > 250 MB)
    if (total > 60 || totalBytes > 250 * 1024 * 1024) {
      dom.largeBatchAlert.style.display = 'flex';
      dom.largeBatchAlertText.textContent = `Batch contains ${total} photos (${formatBytes(totalBytes)}). Processing will occur in memory-safe chunks of ${state.settings.chunkSize} to prevent browser tab strain.`;
    } else {
      dom.largeBatchAlert.style.display = 'none';
    }

    dom.progressCounter.textContent = `${processedCount} / ${total}`;
    const pct = total === 0 ? 0 : Math.round((processedCount / total) * 100);
    dom.progressBarFill.style.width = `${pct}%`;

    dom.saveZipBtn.disabled = processedCount === 0;
    dom.zipBtnText.textContent = processedCount > 0 ? `Save ${processedCount} as ZIP` : 'Save all as ZIP';
  } else {
    dom.batchToolbar.style.display = 'none';
    dom.bottomBar.classList.add('hidden');
    dom.largeBatchAlert.style.display = 'none';
    dom.saveZipBtn.disabled = true;
  }
}

// ============================================================================
// Batch Execution Engine (Memory-Safe Sequential Processing)
// ============================================================================

async function processAllPhotos() {
  if (state.isProcessing) {
    // Request cancellation
    state.cancelRequested = true;
    dom.processBtnText.textContent = 'Stopping...';
    return;
  }

  if (state.photos.length === 0) return;

  state.isProcessing = true;
  state.cancelRequested = false;
  dom.processAllBtn.classList.add('btn-danger');
  dom.processBtnText.textContent = 'Cancel Batch';

  const total = state.photos.length;
  let processed = state.photos.filter(p => p.status === 'done').length;
  let chunkCounter = 0;

  for (let i = 0; i < state.photos.length; i++) {
    if (state.cancelRequested) {
      break;
    }

    const photo = state.photos[i];
    if (photo.status === 'done') {
      continue;
    }

    photo.status = 'processing';
    updateCardStatus(photo);
    dom.progressStatusLabel.textContent = `Squaring ${photo.name}...`;

    try {
      const blob = await processSinglePhoto(photo);
      photo.processedBlob = blob;
      if (photo.processedUrl) URL.revokeObjectURL(photo.processedUrl);
      photo.processedUrl = URL.createObjectURL(blob);
      photo.status = 'done';
      photo.error = null;
      processed++;
    } catch (err) {
      console.error(`Error processing photo ${photo.name}:`, err);
      photo.status = 'error';
      photo.error = err.message || 'Processing failed';
    }

    updateCardStatus(photo);
    updateBatchUI();

    // Yield to the event loop so the UI updates and garbage collection can run
    await new Promise(resolve => setTimeout(resolve, 16));

    chunkCounter++;
    if (chunkCounter >= state.settings.chunkSize) {
      chunkCounter = 0;
      // Extra pause between chunks to allow heavy RAM reclamation
      dom.progressStatusLabel.textContent = 'Reclaiming browser memory...';
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  }

  state.isProcessing = false;
  dom.processAllBtn.classList.remove('btn-danger');
  dom.processBtnText.textContent = 'Process All Photos';
  dom.progressStatusLabel.textContent = state.cancelRequested ? 'Batch paused' : 'All photos processed';
  updateBatchUI();
}

// ============================================================================
// Export & ZIP Generation (via local JSZip)
// ============================================================================

function getExportFilename(originalName, suffix, format) {
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex !== -1 ? originalName.substring(0, dotIndex) : originalName;
  const ext = format === 'image/png' ? '.png' : (format === 'image/webp' ? '.webp' : '.jpg');
  return `${baseName}${suffix}${ext}`;
}

async function downloadSinglePhoto(photo) {
  let blob = photo.processedBlob;
  if (!blob) {
    try {
      blob = await processSinglePhoto(photo);
    } catch (err) {
      alert(`Could not process photo: ${err.message}`);
      return;
    }
  }

  const filename = getExportFilename(photo.name, state.settings.suffix, state.settings.format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportBatchZip() {
  if (typeof window.JSZip === 'undefined') {
    alert('JSZip library was not detected. Please ensure /vendor/jszip.min.js is present.');
    return;
  }

  const processedPhotos = state.photos.filter(p => p.status === 'done' && p.processedBlob);
  if (processedPhotos.length === 0) {
    if (confirm('No photos have been processed yet. Process all photos now?')) {
      await processAllPhotos();
      return exportBatchZip();
    }
    return;
  }

  dom.saveZipBtn.disabled = true;
  dom.zipBtnText.textContent = 'Packaging ZIP...';
  dom.progressStatusLabel.textContent = 'Building ZIP archive...';

  try {
    const zip = new window.JSZip();
    const usedNames = new Set();

    for (const photo of processedPhotos) {
      let filename = getExportFilename(photo.name, state.settings.suffix, state.settings.format);

      // Auto-deduplicate filenames if multiple images have the same base name
      if (usedNames.has(filename)) {
        let counter = 1;
        const dotIndex = filename.lastIndexOf('.');
        const namePart = dotIndex !== -1 ? filename.substring(0, dotIndex) : filename;
        const extPart = dotIndex !== -1 ? filename.substring(dotIndex) : '';
        while (usedNames.has(`${namePart}_${counter}${extPart}`)) {
          counter++;
        }
        filename = `${namePart}_${counter}${extPart}`;
      }
      usedNames.add(filename);

      // Use STORE (no compression) for JPEG and WebP since they are already compressed.
      // Use DEFLATE for PNG to ensure compact lossless output.
      const compressionType = state.settings.format === 'image/png' ? 'DEFLATE' : 'STORE';
      zip.file(filename, photo.processedBlob, {
        binary: true,
        compression: compressionType
      });
    }

    const zipBlob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'STORE',
        streamFiles: true
      },
      (metadata) => {
        dom.zipBtnText.textContent = `Zipping ${Math.round(metadata.percent)}%`;
      }
    );

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const zipFilename = `squarebatch_${timestamp}.zip`;

    const downloadUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = zipFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    dom.progressStatusLabel.textContent = `Downloaded ${zipFilename}`;
  } catch (err) {
    console.error('ZIP export error:', err);
    alert('Failed to generate ZIP archive: ' + err.message);
  } finally {
    dom.saveZipBtn.disabled = false;
    updateBatchUI();
  }
}

// ============================================================================
// Controls Synchronization & Event Listeners
// ============================================================================

function initControls() {
  // Output Size Sync
  dom.outputSizeInput.addEventListener('input', () => {
    let val = parseInt(dom.outputSizeInput.value, 10);
    if (isNaN(val) || val < 200) val = 200;
    if (val > 8000) val = 8000;
    state.settings.outputSize = val;
    updateSizePills(val);
    updatePaddingHint();
    schedulePreviewRender();
  });

  dom.sizePills.forEach(pill => {
    pill.addEventListener('click', () => {
      const size = parseInt(pill.dataset.size, 10);
      dom.outputSizeInput.value = size;
      state.settings.outputSize = size;
      updateSizePills(size);
      updatePaddingHint();
      schedulePreviewRender();
    });
  });

  function updateSizePills(currentSize) {
    dom.sizePills.forEach(p => {
      if (parseInt(p.dataset.size, 10) === currentSize) {
        p.classList.add('active');
      } else {
        p.classList.remove('active');
      }
    });
  }

  // Padding Percentage Sync (Slider + Number)
  dom.paddingSlider.addEventListener('input', () => {
    const val = parseFloat(dom.paddingSlider.value);
    dom.paddingNumber.value = val.toFixed(1);
    state.settings.paddingPercent = val;
    updatePaddingHint();
    schedulePreviewRender();
  });

  dom.paddingNumber.addEventListener('input', () => {
    let val = parseFloat(dom.paddingNumber.value);
    if (isNaN(val)) val = 0;
    if (val < 0) val = 0;
    if (val > 40) val = 40;
    dom.paddingSlider.value = val;
    state.settings.paddingPercent = val;
    updatePaddingHint();
    schedulePreviewRender();
  });

  function updatePaddingHint() {
    const px = Math.round(state.settings.outputSize * (state.settings.paddingPercent / 100));
    dom.paddingPxHint.textContent = `${px}px each side`;
  }
  updatePaddingHint();

  // Background Color Sync (Color input, Hex text, Swatches)
  dom.bgColorPicker.addEventListener('input', (e) => {
    const hex = e.target.value.toUpperCase();
    dom.bgColorHex.value = hex;
    state.settings.bgColor = hex;
    updateActiveSwatch(hex);
    schedulePreviewRender();
  });

  dom.bgColorHex.addEventListener('input', (e) => {
    let hex = e.target.value.trim().toUpperCase();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (/^#[0-9A-F]{6}$/i.test(hex)) {
      dom.bgColorPicker.value = hex;
      state.settings.bgColor = hex;
      updateActiveSwatch(hex);
      schedulePreviewRender();
    }
  });

  dom.swatchButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color.toUpperCase();
      dom.bgColorPicker.value = color;
      dom.bgColorHex.value = color;
      state.settings.bgColor = color;
      updateActiveSwatch(color);
      schedulePreviewRender();
    });
  });

  function updateActiveSwatch(color) {
    dom.swatchButtons.forEach(b => {
      if (b.dataset.color.toUpperCase() === color.toUpperCase()) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });
  }

  // Format Selection
  dom.formatButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.formatButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const format = btn.dataset.format;
      state.settings.format = format;

      // Quality slider is only relevant for lossy formats (JPEG/WebP)
      if (format === 'image/png') {
        dom.qualityControlGroup.style.display = 'none';
      } else {
        dom.qualityControlGroup.style.display = 'flex';
      }
      updateSuffixPreview();
    });
  });

  // Quality Sync
  dom.qualitySlider.addEventListener('input', () => {
    const val = parseInt(dom.qualitySlider.value, 10);
    dom.qualityNumber.value = val;
    dom.qualityValDisplay.textContent = `${val}%`;
    state.settings.quality = val;
  });

  dom.qualityNumber.addEventListener('input', () => {
    let val = parseInt(dom.qualityNumber.value, 10);
    if (isNaN(val)) val = 90;
    if (val < 50) val = 50;
    if (val > 100) val = 100;
    dom.qualitySlider.value = val;
    dom.qualityValDisplay.textContent = `${val}%`;
    state.settings.quality = val;
  });

  // Suffix Input
  dom.suffixInput.addEventListener('input', () => {
    state.settings.suffix = dom.suffixInput.value;
    updateSuffixPreview();
  });

  function updateSuffixPreview() {
    const ext = state.settings.format === 'image/png' ? '.png' : (state.settings.format === 'image/webp' ? '.webp' : '.jpg');
    dom.suffixPreview.textContent = `photo${state.settings.suffix}${ext}`;
  }
  updateSuffixPreview();

  // Chunk Size Select
  dom.chunkSizeSelect.addEventListener('change', () => {
    state.settings.chunkSize = parseInt(dom.chunkSizeSelect.value, 10) || 10;
  });

  // Presets
  dom.presetInstagram.addEventListener('click', () => {
    applyPreset({
      size: 1440,
      padding: 0,
      color: '#FFFFFF',
      format: 'image/jpeg',
      quality: 100
    });
  });

  dom.presetLossless.addEventListener('click', () => {
    applyPreset({
      format: 'image/png'
    });
  });

  dom.presetDarkroom.addEventListener('click', () => {
    applyPreset({
      size: 2000,
      padding: 8,
      color: '#000000',
      format: 'image/jpeg',
      quality: 95
    });
  });

  dom.presetStudioIvory.addEventListener('click', () => {
    applyPreset({
      size: 2000,
      padding: 10,
      color: '#FDFBF7',
      format: 'image/jpeg',
      quality: 95
    });
  });

  function applyPreset(options) {
    if (options.size !== undefined) {
      dom.outputSizeInput.value = options.size;
      state.settings.outputSize = options.size;
      updateSizePills(options.size);
    }
    if (options.padding !== undefined) {
      dom.paddingSlider.value = options.padding;
      dom.paddingNumber.value = options.padding.toFixed(1);
      state.settings.paddingPercent = options.padding;
    }
    if (options.color !== undefined) {
      dom.bgColorPicker.value = options.color;
      dom.bgColorHex.value = options.color;
      state.settings.bgColor = options.color;
      updateActiveSwatch(options.color);
    }
    if (options.format !== undefined) {
      state.settings.format = options.format;
      dom.formatButtons.forEach(b => {
        if (b.dataset.format === options.format) b.classList.add('active');
        else b.classList.remove('active');
      });
      dom.qualityControlGroup.style.display = options.format === 'image/png' ? 'none' : 'flex';
      updateSuffixPreview();
    }
    if (options.quality !== undefined) {
      dom.qualitySlider.value = options.quality;
      dom.qualityNumber.value = options.quality;
      dom.qualityValDisplay.textContent = `${options.quality}%`;
      state.settings.quality = options.quality;
    }
    updatePaddingHint();
    schedulePreviewRender();
  }

  // Eyedropper API (if supported by modern browser)
  if (window.EyeDropper && dom.eyeDropperBtn) {
    dom.eyeDropperBtn.style.display = 'inline-flex';
    dom.eyeDropperBtn.addEventListener('click', async () => {
      try {
        const dropper = new window.EyeDropper();
        const res = await dropper.open();
        if (res?.sRGBHex) {
          const hex = res.sRGBHex.toUpperCase();
          dom.bgColorPicker.value = hex;
          dom.bgColorHex.value = hex;
          state.settings.bgColor = hex;
          updateActiveSwatch(hex);
          schedulePreviewRender();
        }
      } catch {
        // User canceled selection
      }
    });
  }

  // Guide Toggle
  dom.toggleGuideBtn.addEventListener('click', () => {
    state.settings.showGuide = !state.settings.showGuide;
    dom.toggleGuideBtn.classList.toggle('active', state.settings.showGuide);
    dom.toggleGuideBtn.setAttribute('aria-pressed', state.settings.showGuide);
    schedulePreviewRender();
  });

  // 1:1 Pixel Zoom Toggle
  let isZoomed = false;
  if (dom.toggleZoomBtn) {
    dom.toggleZoomBtn.addEventListener('click', () => {
      isZoomed = !isZoomed;
      dom.previewCanvasWrapper.classList.toggle('zoomed', isZoomed);
      dom.previewCanvas.classList.toggle('zoomed', isZoomed);
      dom.toggleZoomBtn.classList.toggle('active', isZoomed);
      dom.toggleZoomBtn.setAttribute('aria-pressed', isZoomed ? 'true' : 'false');
      dom.zoomToggleText.textContent = isZoomed ? '100%' : 'Fit';
    });
  }

  // Previous & Next Photo Buttons
  dom.prevPhotoBtn.addEventListener('click', () => {
    const idx = state.photos.findIndex(p => p.id === state.activePhotoId);
    if (idx > 0) setActivePhoto(state.photos[idx - 1].id);
  });

  dom.nextPhotoBtn.addEventListener('click', () => {
    const idx = state.photos.findIndex(p => p.id === state.activePhotoId);
    if (idx !== -1 && idx < state.photos.length - 1) setActivePhoto(state.photos[idx + 1].id);
  });

  // Keyboard navigation & Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') {
      const idx = state.photos.findIndex(p => p.id === state.activePhotoId);
      if (idx > 0) setActivePhoto(state.photos[idx - 1].id);
    } else if (e.key === 'ArrowRight') {
      const idx = state.photos.findIndex(p => p.id === state.activePhotoId);
      if (idx !== -1 && idx < state.photos.length - 1) setActivePhoto(state.photos[idx + 1].id);
    } else if (e.key.toLowerCase() === 'g') {
      dom.toggleGuideBtn.click();
    } else if (e.key.toLowerCase() === 'z') {
      dom.toggleZoomBtn?.click();
    } else if (e.key === 'Escape' && state.isProcessing) {
      dom.processAllBtn.click();
    }
  });

  // Batch Toolbar Actions
  dom.clearAllBtn.addEventListener('click', clearAllPhotos);

  // File & Folder Ingestion Handlers
  dom.selectFilesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.fileInput.click();
  });

  dom.selectFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.folderInput.click();
  });

  dom.fileInput.addEventListener('change', (e) => {
    if (e.target.files) addFilesToBatch(e.target.files);
    dom.fileInput.value = '';
  });

  dom.folderInput.addEventListener('change', (e) => {
    if (e.target.files) addFilesToBatch(e.target.files);
    dom.folderInput.value = '';
  });

  // Drag and Drop Events on Drop Zone
  dom.dropZone.addEventListener('click', () => {
    dom.fileInput.click();
  });

  dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('dragover');
  });

  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('dragover');
  });

  dom.dropZone.addEventListener('drop', handleDropEvent);

  // Window-wide drag-and-drop support with full-screen overlay
  let windowDragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && e.dataTransfer.types && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-moz-file'))) {
      windowDragDepth++;
      if (dom.windowDragOverlay) dom.windowDragOverlay.classList.add('active');
    }
  });

  window.addEventListener('dragleave', () => {
    windowDragDepth--;
    if (windowDragDepth <= 0) {
      windowDragDepth = 0;
      if (dom.windowDragOverlay) dom.windowDragOverlay.classList.remove('active');
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', (e) => {
    windowDragDepth = 0;
    if (dom.windowDragOverlay) dom.windowDragOverlay.classList.remove('active');
    handleDropEvent(e);
  });

  // Batch Process and ZIP Action Buttons
  dom.processAllBtn.addEventListener('click', processAllPhotos);
  dom.saveZipBtn.addEventListener('click', exportBatchZip);
}

// ============================================================================
// Initialization on Load
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initControls();
  renderLivePreview();
});
