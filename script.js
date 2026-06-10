/**
 * WebP 변환툴
 * 클로드 코드 제작
 * 모든 변환은 사용자의 브라우저 안에서만 수행되며, 어떤 데이터도 외부로 전송하지 않는다.
 * 처리 흐름: 파일 입력 → 검증 → 변환 큐 → 디코드/리샘플링 → WebP 인코딩 → 결과 렌더링
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────
  // 상수
  // ───────────────────────────────────────────────

  const MAX_FILE_BYTES = 50 * 1024 * 1024; // 파일당 최대 50MB
  const MAX_SOURCE_DIMENSION = 16384;      // 주요 브라우저의 캔버스 한 변 한계
  const MAX_SOURCE_PIXELS = 100_000_000;   // 캔버스 면적 보호 한계 (1억 화소)
  const MAX_CONCURRENT = 4;                // 동시 변환 수 — 대량 드롭 시 메모리 보호
  const DOWNLOAD_STAGGER_MS = 200;         // 연속 다운로드 간격 — 브라우저 차단 방지

  // ───────────────────────────────────────────────
  // DOM 참조
  // ───────────────────────────────────────────────

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const qualitySlider = document.getElementById('quality');
  const qualityValue = document.getElementById('quality-value');
  const resizeToggle = document.getElementById('resize-toggle');
  const resizeAmount = document.getElementById('resize-amount');
  const resizeValue = document.getElementById('resize-value');
  const btnClear = document.getElementById('btn-clear');
  const btnDownloadAll = document.getElementById('btn-download-all');
  const resultsSection = document.getElementById('results');
  const resultsList = document.getElementById('file-list');
  const resultsCount = document.getElementById('results-count');
  const resultsSummary = document.getElementById('results-summary');

  // ───────────────────────────────────────────────
  // 상태
  // ───────────────────────────────────────────────

  /** @type {Array<{id:number, file:File, name:string, objectUrl:?string, webpBlob:?Blob, error:?string, quality:number, scale:number, srcW?:number, srcH?:number, outW?:number, outH?:number}>} */
  let items = [];
  let nextId = 0;

  const pendingQueue = [];
  let activeConversions = 0;

  // ───────────────────────────────────────────────
  // 유틸
  // ───────────────────────────────────────────────

  /** 사용자 입력(파일명 등)을 HTML에 넣기 전에 이스케이프한다. */
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function getQuality() {
    // 압축률(슬라이더) → WebP quality (반전)
    return (100 - parseInt(qualitySlider.value, 10)) / 100;
  }

  function getResizeScale() {
    // 해상도 축소율 → 적용 배율 (예: 50% 축소 → 0.5배)
    if (!resizeToggle.checked) return 1;
    return 1 - parseInt(resizeAmount.value, 10) / 100;
  }

  // ───────────────────────────────────────────────
  // 검증
  // ───────────────────────────────────────────────

  /** 디코드 전에 막을 수 있는 문제를 검사한다. 통과 시 null. */
  function validateFile(file) {
    if (!file.type.startsWith('image/')) return '이미지 파일이 아닙니다';
    if (file.size === 0) return '빈 파일입니다';
    if (file.size > MAX_FILE_BYTES) {
      return `파일이 너무 큽니다 (최대 ${formatSize(MAX_FILE_BYTES)})`;
    }
    return null;
  }

  /** 캔버스 한계를 넘거나 크기를 알 수 없는 해상도를 거부한다. 통과 시 null. */
  function validateDimensions(width, height) {
    if (width === 0 || height === 0) {
      return '이미지 크기를 확인할 수 없습니다';
    }
    if (width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION) {
      return `해상도가 너무 큽니다 (한 변 최대 ${MAX_SOURCE_DIMENSION.toLocaleString()}px)`;
    }
    if (width * height > MAX_SOURCE_PIXELS) {
      return '해상도가 너무 큽니다 (최대 1억 화소)';
    }
    return null;
  }

  /** 검증 단계에서 사용자에게 보여줄 메시지를 담는 에러 */
  class ValidationError extends Error {}

  // ───────────────────────────────────────────────
  // 변환 파이프라인
  // ───────────────────────────────────────────────

  /**
   * 파일을 디코드한다. createImageBitmap을 우선 사용하고,
   * 미지원 형식(SVG 등)은 <img> 폴백으로 처리한다.
   */
  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        const bitmap = await createImageBitmap(file);
        return {
          drawable: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          isBitmap: true,
          close: () => bitmap.close?.(),
        };
      } catch {
        // 폴백으로 진행
      }
    }
    const img = await loadImage(file);
    return {
      drawable: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      isBitmap: false,
      close: () => {},
    };
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`decode failed: ${file.name}`));
      };
      img.src = url;
    });
  }

  /**
   * 축소 시 브라우저 네이티브 고품질 리샘플러를 우선 사용한다.
   * 실패하면 null을 반환하고 호출부가 canvas 스케일링으로 처리한다.
   */
  async function tryHighQualityResize(file, width, height) {
    try {
      return await createImageBitmap(file, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });
    } catch {
      return null;
    }
  }

  /** 디코드 → 해상도 검증 → 캔버스 렌더링까지 수행한다. */
  async function rasterize(file, scale) {
    const source = await decodeImage(file);
    const { width: srcW, height: srcH } = source;

    const dimensionError = validateDimensions(srcW, srcH);
    if (dimensionError) {
      source.close();
      throw new ValidationError(dimensionError);
    }

    const outW = Math.max(1, Math.round(srcW * scale));
    const outH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (scale < 1 && source.isBitmap) {
      const resized = await tryHighQualityResize(file, outW, outH);
      if (resized) {
        ctx.drawImage(resized, 0, 0);
        resized.close?.();
        source.close();
        return { canvas, srcW, srcH };
      }
    }

    ctx.drawImage(source.drawable, 0, 0, outW, outH);
    source.close();
    return { canvas, srcW, srcH };
  }

  function encodeWebP(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('encode failed'));
          } else if (blob.type !== 'image/webp') {
            // 일부 구형 브라우저는 WebP 인코딩 미지원 시 PNG로 대체한다
            reject(new ValidationError('이 브라우저는 WebP 인코딩을 지원하지 않습니다'));
          } else {
            resolve(blob);
          }
        },
        'image/webp',
        quality,
      );
    });
  }

  async function convertToWebP(item) {
    try {
      const { canvas, srcW, srcH } = await rasterize(item.file, item.scale);
      const blob = await encodeWebP(canvas, item.quality);

      item.webpBlob = blob;
      item.srcW = srcW;
      item.srcH = srcH;
      item.outW = canvas.width;
      item.outH = canvas.height;
      updateItemDone(item);
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : '이미지를 변환할 수 없습니다';
      updateItemError(item, message);
    }
  }

  // ───────────────────────────────────────────────
  // 변환 큐 — 동시 실행 수를 제한해 메모리 사용을 억제한다
  // ───────────────────────────────────────────────

  function enqueueConversion(item) {
    pendingQueue.push(item);
    drainQueue();
  }

  function drainQueue() {
    while (activeConversions < MAX_CONCURRENT && pendingQueue.length > 0) {
      const item = pendingQueue.shift();
      activeConversions += 1;
      convertToWebP(item).finally(() => {
        activeConversions -= 1;
        drainQueue();
      });
    }
  }

  // ───────────────────────────────────────────────
  // 렌더링
  // ───────────────────────────────────────────────

  function renderItem(item) {
    const li = document.createElement('li');
    li.classList.add('file-item', 'converting');
    li.id = `item-${item.id}`;

    const safeName = escapeHtml(item.file.name);
    const thumb = item.objectUrl
      ? `<img class="file-thumb" src="${item.objectUrl}" alt="" />`
      : '<div class="file-thumb file-thumb-placeholder" aria-hidden="true">✕</div>';
    const gifNote = item.file.type === 'image/gif'
      ? '<div class="file-note">애니메이션 GIF는 첫 프레임만 변환됩니다</div>'
      : '';

    li.innerHTML = `
      ${thumb}
      <div class="file-info">
        <span class="file-name" title="${safeName}">${safeName}</span>
        <div class="file-sizes">
          <span>${formatSize(item.file.size)}</span>
          <span class="size-arrow">→</span>
          <span class="size-after"><span class="spinner"></span></span>
        </div>
        <div class="file-dims"></div>
        ${gifNote}
      </div>
      <div class="file-item-actions">
        <span class="spinner"></span>
      </div>
    `;
    resultsList.prepend(li);
  }

  function updateItemDone(item) {
    const li = document.getElementById(`item-${item.id}`);
    if (!li) return; // 변환 완료 전에 초기화된 경우
    li.classList.remove('converting');

    const saving = item.file.size - item.webpBlob.size;
    const pct = Math.round((Math.abs(saving) / item.file.size) * 100);
    const increased = saving < 0;

    const sizeAfterEl = li.querySelector('.size-after');
    sizeAfterEl.classList.add(increased ? 'larger' : 'smaller');
    sizeAfterEl.textContent = formatSize(item.webpBlob.size);

    const dimsEl = li.querySelector('.file-dims');
    const resized = item.outW !== item.srcW || item.outH !== item.srcH;
    if (resized) {
      dimsEl.innerHTML =
        `${item.srcW}×${item.srcH}` +
        '<span class="size-arrow"> → </span>' +
        `<span class="dims-after">${item.outW}×${item.outH}</span>`;
    } else {
      dimsEl.textContent = `${item.srcW}×${item.srcH}`;
    }

    let badge;
    if (saving > 0) {
      badge = `<span class="file-badge badge-saving">-${pct}%</span>`;
    } else if (saving === 0) {
      badge = '<span class="file-badge badge-saving">±0%</span>';
    } else {
      badge = `<span class="file-badge badge-larger">+${pct}%</span>`;
    }
    li.querySelector('.file-item-actions').innerHTML = `
      ${badge}
      <button type="button" class="btn btn-secondary btn-icon" data-download-id="${item.id}">다운로드</button>
    `;

    updateControls();
  }

  function updateItemError(item, message) {
    item.error = message;

    const li = document.getElementById(`item-${item.id}`);
    if (!li) return;
    li.classList.remove('converting');
    li.classList.add('error');

    const sizeAfterEl = li.querySelector('.size-after');
    sizeAfterEl.textContent = '';
    const errorEl = document.createElement('span');
    errorEl.className = 'error-msg';
    errorEl.textContent = message;
    sizeAfterEl.appendChild(errorEl);

    li.querySelector('.file-item-actions').innerHTML = '';

    updateControls();
  }

  /** 요약 줄과 버튼 활성 상태를 현재 items 기준으로 갱신한다. */
  function updateControls() {
    const done = items.filter((i) => i.webpBlob);
    const failed = items.filter((i) => i.error);

    btnClear.disabled = items.length === 0;
    btnDownloadAll.disabled = done.length === 0;

    const parts = [`${items.length}개 파일`];
    if (failed.length > 0) parts.push(`실패 ${failed.length}개`);
    resultsCount.textContent = parts.join(' · ');

    if (done.length === 0) {
      resultsSummary.textContent = '';
      return;
    }

    const totalOriginal = done.reduce((sum, i) => sum + i.file.size, 0);
    const totalWebP = done.reduce((sum, i) => sum + i.webpBlob.size, 0);
    const saved = totalOriginal - totalWebP;

    if (saved > 0) {
      const pct = Math.round((saved / totalOriginal) * 100);
      resultsSummary.textContent = `총 ${formatSize(saved)} 절약 (${pct}%)`;
      resultsSummary.classList.remove('negative');
    } else {
      resultsSummary.textContent = '용량 증가 (원본이 더 효율적)';
      resultsSummary.classList.add('negative');
    }
  }

  // ───────────────────────────────────────────────
  // 파일 입력 처리
  // ───────────────────────────────────────────────

  function handleFiles(files) {
    if (files.length === 0) return;
    resultsSection.classList.remove('hidden');

    // 설정은 드롭 시점에 고정한다 — 큐 대기 중 슬라이더를 바꿔도 같은 배치는 동일하게 변환
    const quality = getQuality();
    const scale = getResizeScale();

    for (const file of files) {
      const validationError = validateFile(file);
      const item = {
        id: nextId++,
        file,
        name: file.name.replace(/\.[^.]+$/, ''),
        objectUrl: validationError ? null : URL.createObjectURL(file),
        webpBlob: null,
        error: null,
        quality,
        scale,
      };
      items.push(item);
      renderItem(item);

      if (validationError) {
        updateItemError(item, validationError);
      } else {
        enqueueConversion(item);
      }
    }

    updateControls();
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function clearAll() {
    pendingQueue.length = 0;
    items.forEach((item) => {
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    });
    items = [];
    resultsList.innerHTML = '';
    resultsSection.classList.add('hidden');
    updateControls();
  }

  // ───────────────────────────────────────────────
  // 이벤트 바인딩
  // ───────────────────────────────────────────────

  qualitySlider.addEventListener('input', () => {
    qualityValue.textContent = qualitySlider.value;
  });

  resizeToggle.addEventListener('change', () => {
    resizeAmount.disabled = !resizeToggle.checked;
  });

  resizeAmount.addEventListener('input', () => {
    resizeValue.textContent = resizeAmount.value;
  });

  // 드롭존 — 라벨/입력 클릭은 native로 처리되므로 중복 호출 방지
  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('label') || e.target === fileInput) return;
    fileInput.click();
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(Array.from(e.dataTransfer.files));
  });

  // 드롭존 밖에 떨어뜨린 파일이 페이지를 대체하지 않도록 차단
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  fileInput.addEventListener('change', () => {
    handleFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  btnClear.addEventListener('click', clearAll);

  btnDownloadAll.addEventListener('click', () => {
    const done = items.filter((i) => i.webpBlob);
    done.forEach((item, index) => {
      setTimeout(
        () => downloadBlob(item.webpBlob, `${item.name}.webp`),
        index * DOWNLOAD_STAGGER_MS,
      );
    });
  });

  // 다운로드 버튼 — 동적 생성 요소이므로 목록에 위임
  resultsList.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-download-id]');
    if (!button) return;
    const item = items.find((i) => i.id === Number(button.dataset.downloadId));
    if (item?.webpBlob) downloadBlob(item.webpBlob, `${item.name}.webp`);
  });
})();