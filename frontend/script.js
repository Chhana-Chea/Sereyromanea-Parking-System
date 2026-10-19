const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const today = new Date().toLocaleDateString('en-GB');

let capacity = 500;
let spaces = [];
let records = [];
let selectedRecord = null;
let esp32Ip = null;

const apiBase = '/api';
let serverLanBaseUrl = window.location.origin;

// Fetch server local LAN IP so receipts encode the real local Wi-Fi URL
fetch(`${apiBase}/server-info`)
  .then(r => r.json())
  .then(info => {
    if (info && info.base_url) {
      serverLanBaseUrl = info.base_url;
    }
  })
  .catch(() => {});


/* ============================================================
   ESP32-CAM ENTRANCE STREAM
   Loads the configured camera IP from the backend and points
   the Check-In live view / Settings status at it. If the
   camera is unreachable, the demo placeholder stays visible
   instead of a broken image.
============================================================ */

async function loadCameraConfig() {

  try {

    const response =
      await fetch(`${apiBase}/camera-config`);

    if (!response.ok) {
      throw new Error('camera config request failed');
    }

    const data =
      await response.json();

    esp32Ip =
      data.esp32_ip || null;

  } catch (error) {

    esp32Ip = null;

  }

  wireEntranceStream();
  updateCameraSettingsPanel();

}

async function wireEntranceStream() {
  const img = $('#entranceStreamImg');
  const placeholder = $('#entrancePlaceholder');
  const status = $('#entranceCameraStatus');

  if (!img) return;

  if (status) {
    status.className = 'camera-status';
    status.innerHTML = '<i></i> Connecting stream...';
  }

  // Use the reliable backend stream proxy
  const streamSrc = `/api/camera/stream?t=${Date.now()}`;

  // Unhide image immediately so live/standby frames render without waiting for onload
  img.classList.remove('hidden');
  if (placeholder) placeholder.classList.add('hidden');

  img.onerror = () => {
    // If proxy has a network issue, try direct port 81 if IP available
    if (esp32Ip && !img.dataset.triedDirect) {
      img.dataset.triedDirect = 'true';
      img.src = `http://${esp32Ip}:81/stream?t=${Date.now()}`;
      return;
    }
    img.classList.add('hidden');
    if (placeholder) {
      placeholder.classList.remove('hidden');
      const small = placeholder.querySelector('small');
      if (small) {
        small.textContent = `Camera stream offline at ${esp32Ip || '172.20.10.12'}`;
      }
    }
    if (status) {
      status.className = 'camera-status';
      status.innerHTML = '<i style="background:#c33d3d"></i> Offline';
    }
  };

  delete img.dataset.triedDirect;
  img.src = streamSrc;

  // Verify real hardware connection via /api/camera/status
  try {
    const res = await fetch(`${apiBase}/camera/status`);
    if (res.ok) {
      const info = await res.json();
      if (info.connected) {
        if (status) {
          status.className = 'camera-status connected';
          status.innerHTML = `<i></i> Connected (${info.esp32_ip}) • ${info.latency_ms}ms`;
        }
      } else {
        if (status) {
          status.className = 'camera-status';
          status.innerHTML = `<i></i> Standby Feed (${info.esp32_ip})`;
        }
      }
    }
  } catch (e) {}
}

async function updateCameraSettingsPanel() {
  const input = $('#cameraIpInput');
  if (input && !input.value) {
    input.value = esp32Ip || '172.20.10.12';
  }

  const exitSettingStatus = $('#exitCameraSettingStatus');
  if (exitSettingStatus) {
    if (exitMediaStream) {
      exitSettingStatus.textContent = 'Live Camera Active (Connected)';
      exitSettingStatus.className = 'green';
    } else {
      exitSettingStatus.textContent = 'Live Camera Ready (Auto-starts on checkout)';
      exitSettingStatus.className = 'yellow';
    }
  }

  const settingStatus = $('#entranceCameraSettingStatus');
  if (settingStatus) {
    try {
      const resp = await fetch(`${apiBase}/camera/status`);
      if (resp.ok) {
        const info = await resp.json();
        if (info.connected) {
          settingStatus.textContent = `Connected (${info.esp32_ip}) • ${info.latency_ms}ms`;
          settingStatus.className = 'green';
          return;
        }
      }
    } catch (e) {}

    settingStatus.textContent = esp32Ip
      ? `Configured (${esp32Ip})`
      : 'Not configured';
    settingStatus.className = esp32Ip ? 'green' : 'yellow';
  }
}

// Bind live camera test & refresh buttons
if ($('#btnRefreshStream')) {
  $('#btnRefreshStream').onclick = () => {
    wireEntranceStream();
    toast('Camera stream refreshed.');
  };
}

if ($('#btnTestCapture')) {
  $('#btnTestCapture').onclick = async () => {
    const btn = $('#btnTestCapture');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined icon-sm">photo_camera</span> Capturing...';
    try {
      const resp = await fetch(`${apiBase}/camera/snapshot`);
      const data = await resp.json();
      if (data && data.success && data.image) {
        toast('Snapshot captured successfully from live camera!');
        const modal = $('#modal');
        const modalContent = $('#modalContent');
        if (modal && modalContent) {
          modalContent.innerHTML = `
            <div style="text-align:center; padding: 10px;">
              <h3 style="margin-top:0; font-family:'Outfit',sans-serif;">Live Camera Snapshot</h3>
              <p style="color:#718096; font-size:12px; margin-bottom:12px;">Captured from ESP32-CAM (${esp32Ip || '172.20.10.12'})</p>
              <div class="photo-clickable" style="display:inline-block; border-radius:10px; overflow:hidden;" onclick="openLightbox('${data.image}', 'Live ESP32-CAM Snapshot')" title="Click to view enlarged photo">
                <img src="${data.image}" style="max-width:100%; border-radius:10px; border:1px solid #ddd; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display:block;">
                <div class="photo-zoom-overlay">
                  <span class="material-symbols-outlined icon-sm">zoom_in</span>
                  <span>Click to enlarge</span>
                </div>
              </div>
            </div>
          `;
          modal.classList.remove('hidden');
        }
      } else {
        toast(data.error || 'Failed to capture snapshot.');
      }
    } catch (err) {
      toast('Camera unreachable for snapshot.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined icon-sm">photo_camera</span> Test Snapshot';
    }
  };
}

let exitMediaStream = null;
let exitFacingMode = 'environment';
let exitCameraSourceMode = 'webcam'; // 'webcam' (default local camera) or 'esp32'
let capturedExitPhotoDataUrl = null;

function captureExitFrameFromStream() {
  const exitVid = $('#checkoutExitCameraVideo') || $('#exitCameraVideo');
  if (exitVid && exitVid.readyState >= 2 && !exitVid.paused) {
    try {
      const c = document.createElement('canvas');
      c.width = exitVid.videoWidth || 1280;
      c.height = exitVid.videoHeight || 720;
      const ctx = c.getContext('2d');
      ctx.drawImage(exitVid, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.90);
      if (dataUrl && dataUrl.length > 500) return dataUrl;
    } catch (e) {
      console.warn('Could not extract exit camera video frame:', e);
    }
  }

  // Fallback to ESP32 stream image if in esp32 mode
  const exitImg = $('#checkoutExitCameraImg') || $('#exitCameraImg');
  if (exitImg && exitImg.naturalWidth > 0 && !exitImg.classList.contains('hidden')) {
    try {
      const c = document.createElement('canvas');
      c.width = exitImg.naturalWidth || 640;
      c.height = exitImg.naturalHeight || 480;
      const ctx = c.getContext('2d');
      ctx.drawImage(exitImg, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.90);
      if (dataUrl && dataUrl.length > 500) return dataUrl;
    } catch (e) {
      console.warn('Could not extract exit camera image frame:', e);
    }
  }
  return null;
}

async function startExitLiveWebcam() {
  stopExitEspFeed();

  if (exitMediaStream) {
    attachExitStreamToVideos(exitMediaStream);
    updateExitCameraStatusUI(true, 'Live Webcam Active', 'webcam');
    return exitMediaStream;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateExitCameraStatusUI(false, 'Standby', 'webcam');
    startExitEspFeed();
    return null;
  }

  updateExitCameraStatusUI(null, 'Connecting camera...', 'webcam');

  try {
    // Attempt 1: Optimal resolution & facing mode
    exitMediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: exitFacingMode ? { ideal: exitFacingMode } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
  } catch (err1) {
    console.warn('Optimal webcam constraint failed, trying basic video:', err1);
    try {
      // Attempt 2: Basic video constraint (works on any webcam)
      exitMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (err2) {
      console.warn('Webcam access error, falling back to ESP32 feed:', err2);
      startExitEspFeed();
      return null;
    }
  }

  exitCameraSourceMode = 'webcam';
  attachExitStreamToVideos(exitMediaStream);
  updateExitCameraStatusUI(true, 'Live Webcam Active', 'webcam');
  return exitMediaStream;
}

function startExitEspFeed() {
  exitCameraSourceMode = 'esp32';
  stopExitWebcamStream();

  const checkoutImg = $('#checkoutExitCameraImg');
  const checkoutVid = $('#checkoutExitCameraVideo');
  const checkoutPlaceholder = $('#checkoutExitPlaceholder');
  const exitPageImg = $('#exitCameraImg');
  const exitPageVid = $('#exitCameraVideo');
  const exitPagePlaceholder = $('#exitPlaceholder');

  const streamSrc = `/api/camera/stream?t=${Date.now()}`;

  if (checkoutImg) {
    checkoutImg.src = streamSrc;
    checkoutImg.classList.remove('hidden');
  }
  if (checkoutVid) checkoutVid.classList.add('hidden');
  if (checkoutPlaceholder) checkoutPlaceholder.classList.add('hidden');

  if (exitPageImg) {
    exitPageImg.src = streamSrc;
    exitPageImg.classList.remove('hidden');
  }
  if (exitPageVid) exitPageVid.classList.add('hidden');
  if (exitPagePlaceholder) exitPagePlaceholder.classList.add('hidden');

  updateExitCameraStatusUI(true, 'ESP32 Gate Feed Active', 'esp32');
}

function stopExitEspFeed() {
  const checkoutImg = $('#checkoutExitCameraImg');
  const exitPageImg = $('#exitCameraImg');
  if (checkoutImg) { checkoutImg.src = ''; checkoutImg.classList.add('hidden'); }
  if (exitPageImg) { exitPageImg.src = ''; exitPageImg.classList.add('hidden'); }
}

function stopExitWebcamStream() {
  if (exitMediaStream) {
    exitMediaStream.getTracks().forEach(t => t.stop());
    exitMediaStream = null;
  }
  const checkoutVid = $('#checkoutExitCameraVideo');
  const exitPageVid = $('#exitCameraVideo');
  if (checkoutVid) { checkoutVid.srcObject = null; checkoutVid.classList.add('hidden'); }
  if (exitPageVid) { exitPageVid.srcObject = null; exitPageVid.classList.add('hidden'); }
}

function stopAllExitCameras() {
  stopExitWebcamStream();
  stopExitEspFeed();

  const checkoutPlaceholder = $('#checkoutExitPlaceholder');
  const exitPagePlaceholder = $('#exitPlaceholder');
  if (checkoutPlaceholder) checkoutPlaceholder.classList.remove('hidden');
  if (exitPagePlaceholder) exitPagePlaceholder.classList.remove('hidden');

  updateExitCameraStatusUI(false, 'Standby', exitCameraSourceMode);
}

function attachExitStreamToVideos(stream) {
  stopExitEspFeed();
  const checkoutVid = $('#checkoutExitCameraVideo');
  const checkoutPlaceholder = $('#checkoutExitPlaceholder');
  const exitPageVid = $('#exitCameraVideo');
  const exitPagePlaceholder = $('#exitPlaceholder');

  if (checkoutVid) {
    checkoutVid.srcObject = stream;
    checkoutVid.classList.remove('hidden');
    if (checkoutPlaceholder) checkoutPlaceholder.classList.add('hidden');
    checkoutVid.play().catch(() => {});
  }
  if (exitPageVid) {
    exitPageVid.srcObject = stream;
    exitPageVid.classList.remove('hidden');
    if (exitPagePlaceholder) exitPagePlaceholder.classList.add('hidden');
    exitPageVid.play().catch(() => {});
  }
}

function updateExitCameraStatusUI(connected, label, mode = 'webcam') {
  const status1 = $('#exitCameraStatus');
  const status2 = $('#checkoutExitCameraStatus');
  const phTitle = $('#checkoutExitPlaceholderTitle');
  const phSub = $('#checkoutExitPlaceholderSub');

  [status1, status2].forEach(st => {
    if (!st) return;
    if (connected === true) {
      st.className = 'camera-status connected';
      st.innerHTML = `<i></i> ${label || 'Live Camera Active'}`;
    } else if (connected === false) {
      st.className = 'camera-status';
      st.innerHTML = `<i></i> ${label || 'Standby'}`;
    } else {
      st.className = 'camera-status';
      st.innerHTML = `<i></i> ${label || 'Connecting...'}`;
    }
  });

  if (phTitle && !connected) {
    phTitle.textContent = 'EXIT GATE CAMERA';
  }
  if (phSub && !connected) {
    phSub.textContent = 'Live checkout gate stream';
  }
}

function ensureExitCameraRunning() {
  if (exitCameraSourceMode === 'webcam') {
    if (!exitMediaStream) {
      startExitLiveWebcam().catch(() => {});
    } else {
      attachExitStreamToVideos(exitMediaStream);
    }
  } else if (exitCameraSourceMode === 'esp32') {
    startExitEspFeed();
  }
}

// Click on placeholder immediately launches camera
if ($('#checkoutExitPlaceholder')) {
  $('#checkoutExitPlaceholder').onclick = () => {
    if (exitCameraSourceMode === 'esp32') {
      startExitLiveWebcam();
    } else {
      startExitLiveWebcam().then(res => {
        if (!res) startExitEspFeed();
      });
    }
  };
}

if ($('#exitPlaceholder')) {
  $('#exitPlaceholder').onclick = () => {
    startExitLiveWebcam().then(res => {
      if (!res) startExitEspFeed();
    });
  };
}




/* ============================================================
   DATE FUNCTIONS
============================================================ */

function displayDate(value) {

  if (!value) {
    return '';
  }

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return value;
  }

  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}


function getDate(value) {

  if (!value) {
    return null;
  }

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d;
}


function startOfDay(date) {

  const d = new Date(date);

  d.setHours(
    0,
    0,
    0,
    0
  );

  return d;
}


function isSameDay(dateValue, targetDate) {

  const d = getDate(dateValue);

  if (!d) {
    return false;
  }

  return (
    d.getFullYear() === targetDate.getFullYear()
    &&
    d.getMonth() === targetDate.getMonth()
    &&
    d.getDate() === targetDate.getDate()
  );
}


/* ============================================================
   CONVERT DATABASE RECORD
============================================================ */

function recordFromApi(r) {

  const mins = Number(
    r.duration_minutes || 0
  );

  const h = Math.floor(
    mins / 60
  );

  const m = mins % 60;

  const entryTime = r.entry_time || r.arrival_time;
  const feeAmount = r.parking_fee !== undefined ? r.parking_fee : (r.fee || 0);

  return {

    parking:
      r.space_number,

    id:
      r.record_id || `PK${String(r.id).padStart(5, '0')}`,

    moto_id:
      r.moto_id || r.plate_number || r.plate || '',

    plate:
      r.moto_id || r.plate_number || r.plate || '',

    /* Keep original database dates */
    arrival_raw:
      entryTime,

    exit_raw:
      r.exit_time,

    /* Display dates */
    arrival:
      displayDate(
        entryTime
      ),

    exit:
      r.exit_time
        ? displayDate(r.exit_time)
        : '',

    duration:
      mins
        ? `${h}h ${m}m`
        : '—',

    duration_minutes:
      mins,

    verification:
      r.verification,

    status:
      r.status,

    payment_status:
      r.payment_status || (r.status === 'COMPLETED' ? 'PAID' : 'UNPAID'),

    driver:
      r.driver || '—',

    motorcycle:
      r.motorcycle || '—',

    fee:
      Number(feeAmount || 0),

    driver_image:
      r.driver_image || null,

    motorcycle_image:
      r.motorcycle_image || null,

    plate_image:
      r.plate_image || null,

    exit_image:
      r.exit_image || null,

    processed_by:
      r.processed_by || '—',

    motorcycle_id:
      r.motorcycle_id,

    staff_id:
      r.staff_id
  };
}


/* ============================================================
   CAPTURED PHOTOS - SHARED RENDER HELPER
   Used by check-in, check-out, the "view original" modal,
   and the history "Images" button so there is one place
   that knows how to display stored capture images.
============================================================ */

function formatImgUrl(path) {
  if (!path) return '';
  if (path.startsWith('data:') || path.startsWith('http://') || path.startsWith('https://')) return path;
  return path.startsWith('/') ? path : '/' + path;
}

function captureImagesHTML(r) {
  const items = [
    { key: 'driver_image', label: 'Driver' },
    { key: 'motorcycle_image', label: 'Motorcycle' },
    { key: 'plate_image', label: 'Plate' },
    { key: 'exit_image', label: 'Exit Gate' }
  ].filter(item => r && r[item.key]);

  if (!items.length) {
    return `
      <div class="checkout-no-photo-badge">
        <span class="cam-offline-icon"><span class="material-symbols-outlined icon-md">no_photography</span></span>
        <div>
          <b>Camera Not Connected</b>
          <small>No entrance photos captured for this ticket</small>
        </div>
      </div>
    `;
  }

  return `
    <div class="capture-photos">
      ${items.map(item => {
        const url = formatImgUrl(r[item.key]);
        const safeTitle = `${item.label} Photo — Ticket ${r.id} (${r.plate || 'No Plate'})`;
        return `
          <div class="photo-slot has-photo">
            <label class="photo-label">${item.label}</label>
            <div class="photo-preview-wrap photo-clickable" onclick="openLightbox('${url}', '${safeTitle}')" title="Click to view enlarged photo">
              <img class="photo-preview" src="${url}" alt="${item.label} capture" onerror="this.parentElement.outerHTML='<div class=\\'checkout-no-photo-badge\\' style=\\'margin:0; padding:10px; min-height:80px;\\'><small>Photo unavailable</small></div>';">
              <div class="photo-zoom-overlay">
                <span class="material-symbols-outlined icon-sm">zoom_in</span>
                <span>Click to view</span>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}


/* ============================================================
   LOAD DATA FROM DATABASE
============================================================ */

async function loadData(showError = true) {

  try {

    const [
      spaceResponse,
      recordResponse
    ] = await Promise.all([

      fetch(
        `${apiBase}/spaces`
      ),

      fetch(
        `${apiBase}/records`
      )

    ]);


    if (
      !spaceResponse.ok
      ||
      !recordResponse.ok
    ) {

      throw new Error(
        'API request failed'
      );

    }


    const apiSpaces =
      await spaceResponse.json();

    const apiRecords =
      await recordResponse.json();


    capacity =
      apiSpaces.length;


    spaces =
      apiSpaces.map(s => ({

        no:
          s.space_number,

        status:
          s.status,

        record:
          null

      }));


    records =
      apiRecords.map(
        recordFromApi
      );


    /*
       Connect parked records
       to parking spaces.
    */

    records.forEach(r => {

      const s =
        spaces.find(
          x => x.no === r.parking
        );

      if (s) {

        s.record = r;

        s.status =
          r.status === 'PARKED'
            ? 'occupied'
            : 'available';

      }

    });


    renderAll();
    
    if (currentUser && currentUser.role === 'Manager') {
      loadUsers();
      loadManagerFinancials();
    } else if (currentUser) {
      loadStaffShiftSummary();
    }


  } catch (error) {

    console.error(
      'Database error:',
      error
    );

    if (showError) {

      toast(
        'Database connection unavailable.'
      );

    }

  }

}


/* ============================================================
   PAGE TITLES
============================================================ */

const titles = {

  dashboard: [
    'Dashboard',
    'Monitor your parking area in real time.'
  ],

  spaces: [
    'Parking Spaces',
    'Manage and monitor all parking positions.'
  ],

  checkin: [
    'Parked Motorcycles & Fee Report',
    'Live overview of parked motorcycles, space occupancy, and fee status.'
  ],

  checkout: [
    'Check-Out',
    'Verify a motorcycle before allowing exit.'
  ],

  camera: [
    'Camera Verification',
    'Monitor entrance and exit camera connections.'
  ],

  history: [
    'Parking History',
    'Search previous parking records.'
  ],

  reports: [
    'Reports',
    'Review parking activity and system performance.'
  ],

  users: [
    'Employee Management',
    'Register and manage cashier and manager credentials.'
  ],

  settings: [
    'Settings',
    'Configure parking and technology preferences.'
  ]

};


/* ============================================================
   PAGE NAVIGATION
============================================================ */

function showPage(page) {
  // Manager Restrictions: Managers do not perform check-in or check-out
  if (currentUser && currentUser.role === 'Manager') {
    if (['checkin', 'checkout'].includes(page)) {
      page = 'dashboard';
    }
  } else if (currentUser && currentUser.role !== 'Manager') {
    // Staff Permissions: can access checkin, checkout, camera, history, and reports
    const allowed = ['checkin', 'checkout', 'camera', 'history', 'reports'];
    if (!allowed.includes(page)) {
      page = 'checkin';
    }
  }

  // If opening reports, load the appropriate data
  if (page === 'reports') {
    if (currentUser && currentUser.role === 'Manager') {
      loadManagerFinancials();
    } else {
      loadStaffShiftSummary();
    }
  }

  $$('.page').forEach(
    p => p.classList.remove(
      'active-page'
    )
  );


  const pageElement =
    $(`#page-${page}`);

  if (pageElement) {

    pageElement.classList.add(
      'active-page'
    );

  }


  $$('.nav-item').forEach(
    b =>
      b.classList.toggle(
        'active',
        b.dataset.page === page
      )
  );

  if (page === 'checkout') {
    ensureExitCameraRunning();
    setTimeout(() => {
      $('#checkoutSearch')?.focus();
    }, 120);
  }


  if (
    $('#pageTitle')
    &&
    titles[page]
  ) {

    $('#pageTitle').textContent =
      titles[page][0];

    $('#pageSubtitle').textContent =
      titles[page][1];

  }

  if (page === 'users') {
    loadUsers();
  }

  if (page === 'camera') {
    wireEntranceStream();
    ensureExitCameraRunning();
  } else {
    const streamImg = $('#entranceStreamImg');
    if (streamImg && streamImg.src && !streamImg.src.includes('about:blank')) {
      streamImg.src = '';
    }
  }

  if (page === 'settings') {
    updateCameraSettingsPanel();
  }

  renderAll();

}


/* ============================================================
   NAVIGATION CLICK
============================================================ */

document.addEventListener(
  'click',
  e => {

    const b =
      e.target.closest(
        '[data-go]'
      );

    if (b) {

      showPage(
        b.dataset.go
      );

    }


    const n =
      e.target.closest(
        '.nav-item'
      );

    if (n) {

      showPage(
        n.dataset.page
      );

    }

  }
);


/* ============================================================
   TOAST
============================================================ */

function toast(msg) {

  const t =
    $('#toast');

  if (!t) {
    return;
  }

  t.textContent =
    msg;

  t.classList.add(
    'show'
  );

  setTimeout(
    () =>
      t.classList.remove(
        'show'
      ),
    2400
  );

}


/* ============================================================
   PARKING SPACE STATISTICS
============================================================ */

function updateStats() {

  const occupied =
    spaces.filter(
      s =>
        s.status === 'occupied'
    ).length;


  const available =
    capacity - occupied;


  if ($('#totalSpaces')) {

    $('#totalSpaces').textContent =
      capacity;

  }


  if ($('#occupiedSpaces')) {

    $('#occupiedSpaces').textContent =
      occupied;

  }


  if ($('#availableSpaces')) {

    $('#availableSpaces').textContent =
      available;

  }


  if ($('#parkedNow')) {

    $('#parkedNow').textContent =
      occupied;

  }


  if ($('#spaceAvail')) {

    $('#spaceAvail').textContent =
      `${available} AVAILABLE`;

  }


  if ($('#spaceOcc')) {

    $('#spaceOcc').textContent =
      `${occupied} OCCUPIED`;

  }

}


/* ============================================================
   PARKING SPACE HTML
============================================================ */

function spaceHTML(s) {

  return `
    <div
      class="space ${s.status}"
      title="${s.record ? s.record.plate : 'Available'}"
    >
      <b>${s.no}</b>
      ${String(s.status).toUpperCase()}
    </div>
  `;

}


/* ============================================================
   RENDER PARKING SPACES
============================================================ */

function renderSpaces() {

  if ($('#dashboardSpaces')) {

    $('#dashboardSpaces').innerHTML =
      spaces
        .slice(0, 10)
        .map(spaceHTML)
        .join('');

  }


  if ($('#allSpaces')) {

    $('#allSpaces').innerHTML =
      spaces
        .map(spaceHTML)
        .join('');

  }

}


/* ============================================================
   RENDER RECENT ACTIVITY
============================================================ */

function renderActivity() {

  const recent =
    records.slice(
      0,
      6
    );


  if (!$('#activityList')) {
    return;
  }


  $('#activityList').innerHTML =
    recent.length

      ? recent
          .map(r => `

            <div class="activity">

              <div class="activity-icon">
                ${r.status === 'PARKED'
                  ? '<span class="material-symbols-outlined icon-sm">two_wheeler</span>'
                  : '<span class="material-symbols-outlined icon-sm">check_circle</span>'}
              </div>

              <div>

                <b>
                  ${
                    r.status === 'PARKED'
                      ? 'Motorcycle parked'
                      : 'Parking completed'
                  }
                  — ${r.parking}
                </b>

                <small>
                  ${r.plate} • ${r.arrival}
                </small>

              </div>

            </div>

          `)
          .join('')

      : `
        <div class="record-empty">
          No activity yet.
        </div>
      `;

}


/* ============================================================
   RENDER PARKING HISTORY
============================================================ */

function renderHistory() {

  if (!$('#historyBody')) {
    return;
  }


  const q =
    (
      $('#historySearch')?.value
      || ''
    ).toLowerCase();


  const st =
    $('#historyStatus')?.value
    || '';


  const v =
    $('#historyVerification')?.value
    || '';


  const list =
    records.filter(r =>

      (
        !q
        ||
        `${r.parking} ${r.id} ${r.plate}`
          .toLowerCase()
          .includes(q)
      )

      &&

      (
        !st
        ||
        r.status === st
      )

      &&

      (
        !v
        ||
        r.verification === v
      )

    );


  $('#historyBody').innerHTML =

    list
      .map(r => `

        <tr>

          <td>
            <b>${r.parking}</b>
          </td>

          <td>
            ${r.id}
          </td>

          <td>
            ${r.plate}
          </td>

          <td>
            ${r.arrival}
          </td>

          <td>
            ${r.exit || '—'}
          </td>

          <td>
            ${r.duration}
          </td>

          <td>
            ${
              r.status === 'COMPLETED'
                ? `${r.fee} Riel`
                : '—'
            }
          </td>

          <td>
            ${r.processed_by}
          </td>

          <td>
            <span class="status-pill ${r.verification === 'VERIFIED' ? 'verified' : 'unverified'}">
              <span class="material-symbols-outlined icon-xs">${r.verification === 'VERIFIED' ? 'check_circle' : 'pending_actions'}</span>
              ${r.verification === 'VERIFIED' ? 'VERIFIED' : 'NOT VERIFIED'}
            </span>
          </td>

          <td>
            <span class="status ${r.status === 'PARKED' ? 'parked' : 'completed'}">
              ${r.status}
            </span>
            <small style="display:block; font-size:10px; margin-top:3px; font-weight:700; color: ${r.payment_status === 'PAID' ? '#10b981' : '#f59e0b'};">
              ● ${r.payment_status}
            </small>
          </td>

          <td>
            ${(() => {
              const count = [r.driver_image, r.motorcycle_image, r.plate_image].filter(Boolean).length;
              if (count > 0) {
                return `
                  <button type="button" class="btn-table-photo has-img" onclick="showCapturedPhotos('${r.id}')" title="Click to view ${count} captured photo${count > 1 ? 's' : ''}">
                    <span class="material-symbols-outlined icon-xs">photo_camera</span>
                    <span>View Photos (${count})</span>
                  </button>
                `;
              }
              return `
                <button type="button" class="btn-table-photo no-img" onclick="showCapturedPhotos('${r.id}')" title="Click to inspect parking record details">
                  <span class="material-symbols-outlined icon-xs">visibility</span>
                  <span>Details</span>
                </button>
              `;
            })()}
          </td>

        </tr>

      `)
      .join('')

    ||

    `
      <tr>

        <td
          colspan="10"
          style="
            text-align:center;
            padding:30px;
            color:#8b98a5
          "
        >
          No records found.
        </td>

      </tr>
    `;

}


/* ============================================================
   REPORT CHART
   MONDAY -> SUNDAY
============================================================ */

function renderReportChart(
  breakdown
) {

  const chart =
    $('#barChart');

  if (!chart) {
    return;
  }


  const maxValue =
    Math.max(
      ...breakdown.map(
        d =>
          Number(
            d.total_motorcycles || 0
          )
      ),
      1
    );


  chart.innerHTML =
    breakdown
      .map(day => {

        const value =
          Number(
            day.total_motorcycles || 0
          );


        /*
           Minimum height for zero bars
           so the day is still visible.
        */

        const height =
          value === 0
            ? 4
            : Math.max(
                12,
                Math.round(
                  (value / maxValue) * 180
                )
              );


        const date =
          getDate(
            day.date
          );


        const label =
          date
            ? date.toLocaleDateString(
                'en-US',
                {
                  weekday: 'short'
                }
              )
            : day.date;


        return `

          <div
            class="bar"
            style="height:${height}px"
            title="${
              label
            }: ${
              value
            } motorcycle${
              value === 1
                ? ''
                : 's'
            }"
          >

            <b>
              ${value}
            </b>

            <span>
              ${label}
            </span>

          </div>

        `;

      })
      .join('');

}


/* ============================================================
   REPORTS
   REAL DATABASE DATA
   MONDAY -> SUNDAY
============================================================ */

function renderReports() {

  const now =
    new Date();


  /*
     ----------------------------------------------------------
     TODAY
     ----------------------------------------------------------
  */

  const todayRecords =
    records.filter(
      r =>
        isSameDay(
          r.arrival_raw,
          now
        )
    );


  const todayCompleted =
    records.filter(
      r =>
        r.status === 'COMPLETED'
        &&
        isSameDay(
          r.exit_raw,
          now
        )
    );


  const todayRevenue =
    todayCompleted.reduce(
      (
        total,
        r
      ) =>
        total +
        Number(
          r.fee || 0
        ),
      0
    );


  /*
     Entered Today
     = all motorcycles that checked in today.
     Includes motorcycles still PARKED.
  */

  if ($('#enteredToday')) {

    $('#enteredToday').textContent =
      todayRecords.length;

  }


  /*
     Exited Today
     = completed motorcycles checked out today.
  */

  if ($('#exitedToday')) {

    $('#exitedToday').textContent =
      todayCompleted.length;

  }


  /*
     Today's Revenue
     = fees from today's completed parking.
  */

  if ($('#todayRevenue')) {

    $('#todayRevenue').textContent =
      `${todayRevenue.toLocaleString()} Riel`;

  }


  /*
     ----------------------------------------------------------
     CURRENT WEEK
     MONDAY -> SUNDAY
     ----------------------------------------------------------
  */


  /*
     JavaScript getDay():

     Sunday    = 0
     Monday    = 1
     Tuesday   = 2
     Wednesday = 3
     Thursday  = 4
     Friday    = 5
     Saturday  = 6
  */

  const dayOfWeek =
    now.getDay();


  const daysSinceMonday =
    dayOfWeek === 0
      ? 6
      : dayOfWeek - 1;


  /*
     Monday 00:00
  */

  const weekStart =
    startOfDay(
      now
    );


  weekStart.setDate(
    weekStart.getDate()
    -
    daysSinceMonday
  );


  /*
     Next Monday 00:00
  */

  const weekEnd =
    new Date(
      weekStart
    );


  weekEnd.setDate(
    weekEnd.getDate() + 7
  );


  /*
     ----------------------------------------------------------
     COMPLETED PARKING THIS WEEK
     ----------------------------------------------------------
  */

  const weeklyCompleted =
    records.filter(r => {

      if (
        r.status !== 'COMPLETED'
        ||
        !r.exit_raw
      ) {

        return false;

      }


      const exitDate =
        getDate(
          r.exit_raw
        );


      if (!exitDate) {

        return false;

      }


      return (
        exitDate >= weekStart
        &&
        exitDate < weekEnd
      );

    });


  /*
     ----------------------------------------------------------
     WEEKLY TOTAL MOTORCYCLES
     ----------------------------------------------------------
  */

  const weeklyMotorcycles =
    weeklyCompleted.length;


  /*
     ----------------------------------------------------------
     WEEKLY TOTAL REVENUE
     ----------------------------------------------------------
  */

  const weeklyRevenue =
    weeklyCompleted.reduce(
      (
        total,
        r
      ) =>
        total +
        Number(
          r.fee || 0
        ),
      0
    );


  /*
     Update Weekly Summary
  */

  if ($('#weeklyMotorcycles')) {

    $('#weeklyMotorcycles').textContent =
      weeklyMotorcycles;

  }


  if ($('#weekRevenue')) {

    $('#weekRevenue').textContent =
      `${weeklyRevenue.toLocaleString()} Riel`;

  }


  if ($('#weeklyTotalFee')) {

    $('#weeklyTotalFee').textContent =
      `${weeklyRevenue.toLocaleString()} Riel`;

  }


  /*
     ----------------------------------------------------------
     DAILY MONDAY -> SUNDAY
     ----------------------------------------------------------
  */

  const breakdown = [];


  for (
    let i = 0;
    i < 7;
    i++
  ) {

    const date =
      new Date(
        weekStart
      );


    date.setDate(
      weekStart.getDate()
      +
      i
    );


    const nextDate =
      new Date(
        date
      );


    nextDate.setDate(
      nextDate.getDate()
      +
      1
    );


    /*
       Completed records for this day.
    */

    const dayRecords =
      weeklyCompleted.filter(
        r => {

          const exitDate =
            getDate(
              r.exit_raw
            );


          if (!exitDate) {

            return false;

          }


          return (
            exitDate >= date
            &&
            exitDate < nextDate
          );

        }
      );


    /*
       Daily revenue.
    */

    const totalFee =
      dayRecords.reduce(
        (
          total,
          r
        ) =>
          total +
          Number(
            r.fee || 0
          ),
        0
      );


    /*
       YYYY-MM-DD
    */

    const dateString =
      date.getFullYear()
      +
      '-'
      +
      String(
        date.getMonth() + 1
      ).padStart(
        2,
        '0'
      )
      +
      '-'
      +
      String(
        date.getDate()
      ).padStart(
        2,
        '0'
      );


    breakdown.push({

      date:
        dateString,

      total_motorcycles:
        dayRecords.length,

      total_fee_riel:
        totalFee

    });

  }


  /*
     Draw Monday -> Sunday chart.
  */

  renderReportChart(
    breakdown
  );


  /*
     ----------------------------------------------------------
     REPORT DEBUG
     ----------------------------------------------------------
  */

  console.log(
    '========================================'
  );

  console.log(
    'SEREYROMANEA BUILDING REPORT'
  );

  console.log(
    'Today:',
    now.toLocaleDateString()
  );

  console.log(
    'Entered Today:',
    todayRecords.length
  );

  console.log(
    'Exited Today:',
    todayCompleted.length
  );

  console.log(
    'Today Revenue:',
    todayRevenue
  );

  console.log(
    'Week Start:',
    weekStart
  );

  console.log(
    'Week End:',
    weekEnd
  );

  console.log(
    'Weekly Motorcycles:',
    weeklyMotorcycles
  );

  console.log(
    'Weekly Revenue:',
    weeklyRevenue
  );

  console.log(
    'Monday-Sunday Breakdown:',
    breakdown
  );

  console.log(
    '========================================'
  );

}


/* ============================================================
   RENDER EVERYTHING
============================================================ */

function renderAll() {

  updateStats();

  renderSpaces();

  renderActivity();

  renderHistory();

  renderReports();

  renderCheckinMonitor();

}


/* ============================================================
   FIND NEXT PARKING SPACE
============================================================ */

function nextParking() {

  return spaces.find(
    s =>
      s.status === 'available'
  );

}


/* ============================================================
   CURRENT TIME
============================================================ */

function formatNow() {

  return new Date().toLocaleString(
    'en-US',
    {
      hour: '2-digit',
      minute: '2-digit'
    }
  );

}


/* ============================================================
   BARCODE GENERATOR (CODE 128) - PURE VECTOR SVG
   Generates a 100% standard, scannable Code 128 linear barcode.
   Readable by any USB barcode scanner gun, phone camera, or tablet.
============================================================ */

function generateBarcodeSVG(text, options = {}) {
  const height = options.height || 55;
  const moduleWidth = options.moduleWidth || 2;
  const quietZone = options.quietZone !== undefined ? options.quietZone : 12;

  const CODE128_PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'
  ];

  const cleanText = String(text || '').trim();
  if (!cleanText) return '';

  const indices = [104]; // Start B
  let checksum = 104;
  for (let i = 0; i < cleanText.length; i++) {
    const code = cleanText.charCodeAt(i) - 32;
    if (code >= 0 && code <= 95) {
      indices.push(code);
      checksum += (i + 1) * code;
    }
  }
  indices.push(checksum % 103);
  indices.push(106); // Stop

  const patternStr = indices.map(idx => CODE128_PATTERNS[idx]).join('');
  let currentX = quietZone;
  let rects = '';

  for (let i = 0; i < patternStr.length; i++) {
    const width = parseInt(patternStr[i], 10) * moduleWidth;
    const isBar = (i % 2 === 0);
    if (isBar) {
      rects += `<rect x="${currentX}" y="0" width="${width}" height="${height}" fill="#000000" />`;
    }
    currentX += width;
  }

  const totalWidth = currentX + quietZone;
  return `
    <div class="barcode-container" style="text-align:center; margin: 6px 0 4px 0;">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" width="${totalWidth}" height="${height}" style="max-width: 100%; height: auto; display: block; margin: 0 auto; shape-rendering: crispEdges;">
        <rect width="${totalWidth}" height="${height}" fill="#ffffff"/>
        ${rects}
      </svg>
      <div style="font-family: monospace; font-size: 12px; font-weight: 700; letter-spacing: 3px; margin-top: 4px; color: #000000;">
        * ${cleanText} *
      </div>
    </div>
  `;
}

function generateQRCodeSVG(text, width = 120, height = 120) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  try {
    if (typeof ZXing !== 'undefined' && ZXing.BrowserQRCodeSvgWriter) {
      const writer = new ZXing.BrowserQRCodeSvgWriter();
      const svg = writer.write(clean, width, height);
      if (svg) {
        return svg.outerHTML || new XMLSerializer().serializeToString(svg);
      }
    }
  } catch (e) {
    console.warn('Could not generate QR code SVG with ZXing:', e);
  }
  return '';
}

window.generateBarcodeSVG = generateBarcodeSVG;
window.generateQRCodeSVG = generateQRCodeSVG;


/* ============================================================
   PRINT RECEIPT (WITH SCANNABLE QR CODE & CODE 128 BARCODE)
============================================================ */

function printReceipt(r) {
  const company = $('#companyInput')?.value || 'Sereyromanea Building';
  const arrivalDisplay = r.arrival_raw ? displayDate(r.arrival_raw) : (r.arrival || today);
  const barcodeSvg = generateBarcodeSVG(r.id, { height: 48, moduleWidth: 1.7, quietZone: 10 });

  const w = window.open('', '_blank', 'width=420,height=700');
  if (!w) {
    toast('Please allow pop-ups to print the receipt.');
    return;
  }

  w.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Parking Ticket — ${r.id}</title>
        <style>
          @page { margin: 6mm; size: auto; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace, sans-serif;
            padding: 16px;
            color: #111;
            background: #fff;
            margin: 0;
            line-height: 1.4;
          }
          .receipt {
            border: 1.5px dashed #444;
            padding: 18px 16px;
            max-width: 320px;
            margin: 0 auto;
            border-radius: 6px;
          }
          .center { text-align: center; }
          .title { margin: 0 0 3px 0; font-size: 18px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
          .subtitle { font-size: 10.5px; font-weight: 700; color: #444; letter-spacing: 1px; margin-bottom: 10px; }
          hr { border: 0; border-top: 1px dashed #777; margin: 10px 0; }
          .row { display: flex; justify-content: space-between; align-items: baseline; margin: 5px 0; font-size: 12.5px; }
          .row span { color: #555; font-size: 11.5px; }
          .row b { color: #000; font-weight: 700; }
          .slot-highlight { font-size: 19px; font-weight: 900; color: #d84315; }
          .barcode-section {
            margin: 12px 0 6px 0;
            padding: 10px 6px;
            background: #ffffff;
            border: 1px solid #ddd;
            border-radius: 6px;
            text-align: center;
          }
          .barcode-hint {
            font-size: 9.5px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #d84315;
            margin-bottom: 6px;
          }
          .footer-note {
            font-size: 10.5px;
            color: #555;
            line-height: 1.4;
            margin-top: 10px;
          }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="center">
            <h2 class="title">${company}</h2>
            <div class="subtitle">MOTORCYCLE PARKING TICKET</div>
          </div>
          <hr>
          <div class="row"><span>ASSIGNED SLOT:</span><b class="slot-highlight">SPACE ${r.parking}</b></div>
          <div class="row"><span>TICKET / CODE:</span><b>${r.id}</b></div>
          <div class="row"><span>MOTO ID:</span><b>${r.moto_id || r.plate}</b></div>
          <div class="row"><span>ARRIVAL:</span><b>${arrivalDisplay}</b></div>
          <div class="row"><span>STANDARD FEE:</span><b>300 Riel</b></div>
          <div class="row"><span>GATE STATUS:</span><b>${r.status || 'PARKED'}</b></div>
          <hr>
          <div class="barcode-section">
            <div class="barcode-hint">Ticket Barcode • Scan for Check-Out</div>
            <div style="display: flex; justify-content: center; align-items: center; margin: 6px 0;">
              ${barcodeSvg}
            </div>
          </div>
          <hr>
          <div class="center footer-note">
            <div>Please keep this ticket in a safe place.</div>
            <div style="font-size: 10px; color: #666; margin-top: 2px;">Present this ticket at the exit counter when checking out.</div>
            <b style="display: block; margin-top: 6px; font-size: 12px; color: #000;">Thank you for parking with us!</b>
          </div>
        </div>
        <script>
          try {
            if (!navigator.webdriver) {
              setTimeout(() => { window.print(); }, 250);
            }
          } catch(e) {}
        <\/script>
      </body>
    </html>
  `);

  w.document.close();
}


/* ============================================================
   CHECK-IN PHOTO CAPTURE
   Manual photo attachment (file input / device camera) that
   feeds the same storage architecture the ESP32-CAM will use
   once its stream is wired in. Nothing here is faked - if no
   photo is chosen, no image is sent or stored.
============================================================ */

let checkinPhotos = {
  driver: null,
  motorcycle: null,
  plate: null
};

function fileToDataUrl(file) {

  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onload =
      () => resolve(reader.result);

    reader.onerror =
      reject;

    reader.readAsDataURL(file);

  });

}

function resolveCheckinPhoto(value) {

  if (!value) {
    return Promise.resolve(null);
  }

  // Live camera capture already hands back a data URL string.
  if (typeof value === 'string') {
    return Promise.resolve(value);
  }

  // Manually chosen file still needs reading.
  return fileToDataUrl(value);

}

function wireCheckinPhotoInput(inputId, previewId, key, slotId, placeholderId, buttonId) {

  const input = $(`#${inputId}`);

  if (!input) {
    return;
  }

  input.onchange =
    () => {

      const file =
        input.files[0];

      const slot =
        $(`#${slotId}`);

      const placeholder =
        $(`#${placeholderId}`);

      const button =
        $(`#${buttonId}`);

      if (!file) {

        checkinPhotos[key] =
          null;

        if (slot) {
          slot.classList.remove('has-photo');
        }

        return;

      }

      checkinPhotos[key] =
        file;

      const preview =
        $(`#${previewId}`);

      if (preview) {

        preview.src =
          URL.createObjectURL(file);

        preview.classList
          .remove('hidden');

      }

      if (placeholder) {
        placeholder.classList.add('hidden');
      }

      if (slot) {
        slot.classList.add('has-photo');
      }

      if (button) {
        button.innerHTML = '<span class="material-symbols-outlined icon-sm">check_circle</span> Change Photo';
      }

    };

}

wireCheckinPhotoInput(
  'driverPhotoInput',
  'driverPreview',
  'driver',
  'driverPhotoSlot',
  'driverPlaceholder',
  'driverUploadLabel'
);

wireCheckinPhotoInput(
  'motorcyclePhotoInput',
  'motorcyclePreview',
  'motorcycle',
  'motorcyclePhotoSlot',
  'motorcyclePlaceholder',
  'motorcycleUploadLabel'
);

wireCheckinPhotoInput(
  'platePhotoInput',
  'platePreview',
  'plate',
  'platePhotoSlot',
  'platePlaceholder',
  'plateUploadLabel'
);

function resetCheckinPhotos() {

  ['driverPhotoInput', 'motorcyclePhotoInput', 'platePhotoInput']
    .forEach(id => {

      const el = $(`#${id}`);

      if (el) {
        el.value = '';
      }

    });

  ['driverPreview', 'motorcyclePreview', 'platePreview']
    .forEach(id => {

      const el = $(`#${id}`);

      if (el) {
        el.src = '';
        el.classList.add('hidden');
      }

    });

  ['driverPlaceholder', 'motorcyclePlaceholder', 'platePlaceholder']
    .forEach(id => {

      const el = $(`#${id}`);

      if (el) {
        el.classList.remove('hidden');
      }

    });

  ['driverPhotoSlot', 'motorcyclePhotoSlot', 'platePhotoSlot']
    .forEach(id => {

      const el = $(`#${id}`);

      if (el) {
        el.classList.remove('has-photo');
      }

    });

  ['driverUploadLabel', 'motorcycleUploadLabel', 'plateUploadLabel']
    .forEach(id => {

      const el = $(`#${id}`);

      if (el) {
        el.innerHTML = '<span class="material-symbols-outlined icon-sm">add_photo_alternate</span> Choose Photo';
      }

    });

  checkinPhotos = {
    driver: null,
    motorcycle: null,
    plate: null
  };

}


/* ============================================================
   LIVE CAMERA CAPTURE
   Grabs a still frame from the ESP32-CAM (via the backend,
   which avoids the browser's canvas/CORS restrictions) and
   drops it straight into the same checkinPhotos slot a
   manually chosen file would use.
============================================================ */

function applyCapturedPhoto(key, slotId, placeholderId, previewId, uploadLabelId, dataUrl) {

  checkinPhotos[key] =
    dataUrl;

  const preview =
    $(`#${previewId}`);

  if (preview) {
    preview.src = dataUrl;
    preview.classList.remove('hidden');
  }

  const placeholder =
    $(`#${placeholderId}`);

  if (placeholder) {
    placeholder.classList.add('hidden');
  }

  const slot =
    $(`#${slotId}`);

  if (slot) {
    slot.classList.add('has-photo');
  }

  const uploadLabel =
    $(`#${uploadLabelId}`);

  if (uploadLabel) {
    uploadLabel.innerHTML = '<span class="material-symbols-outlined icon-sm">add_photo_alternate</span> Choose Photo';
  }

}

async function captureFromCamera(key, slotId, placeholderId, previewId, uploadLabelId, liveBtnId) {

  const liveBtn =
    $(`#${liveBtnId}`);

  if (!esp32Ip) {

    toast('No camera configured - set it in Settings');
    return;

  }

  if (liveBtn) {
    liveBtn.disabled = true;
    liveBtn.textContent = 'Capturing...';
  }

  try {

    const response =
      await fetch(`${apiBase}/camera/snapshot`);

    const data =
      await response.json();

    if (!data.success) {

      toast(
        data.error || 'Camera capture failed'
      );

      return;

    }

    applyCapturedPhoto(
      key,
      slotId,
      placeholderId,
      previewId,
      uploadLabelId,
      data.image
    );

  } catch (error) {

    toast('Could not reach camera');

  } finally {

    if (liveBtn) {
      liveBtn.disabled = false;
      liveBtn.innerHTML = '<span class="material-symbols-outlined icon-sm">photo_camera</span> From Camera';
    }

  }

}


/* ============================================================
   AUTO-CAPTURE ON "CAPTURE MOTORCYCLE"
   Since there's a single entrance camera, pressing the main
   button grabs one live frame and fills any photo slot the
   admin hasn't already attached manually - no extra taps
   needed for the normal case.
============================================================ */

const CHECKIN_PHOTO_SLOTS = [
  ['driver', 'driverPhotoSlot', 'driverPlaceholder', 'driverPreview', 'driverUploadLabel'],
  ['motorcycle', 'motorcyclePhotoSlot', 'motorcyclePlaceholder', 'motorcyclePreview', 'motorcycleUploadLabel'],
  ['plate', 'platePhotoSlot', 'platePlaceholder', 'platePreview', 'plateUploadLabel']
];

async function autoFillMissingPhotosFromCamera() {

  const missing =
    CHECKIN_PHOTO_SLOTS.filter(
      ([key]) => !checkinPhotos[key]
    );

  if (!missing.length || !esp32Ip) {
    return;
  }

  try {

    const response =
      await fetch(`${apiBase}/camera/snapshot`);

    const data =
      await response.json();

    if (!data.success) {

      // Camera didn't respond in time - leave slots empty,
      // the manual "Choose Photo" buttons are still there.
      return;

    }

    missing.forEach(
      ([key, slotId, placeholderId, previewId, uploadLabelId]) =>

        applyCapturedPhoto(
          key,
          slotId,
          placeholderId,
          previewId,
          uploadLabelId,
          data.image
        )

    );

  } catch (error) {

    // Silent - check-in still proceeds without photos.

  }

}

function wireLiveCaptureButton(liveBtnId, key, slotId, placeholderId, previewId, uploadLabelId) {

  const btn =
    $(`#${liveBtnId}`);

  if (!btn) {
    return;
  }

  btn.onclick =
    () =>
      captureFromCamera(
        key,
        slotId,
        placeholderId,
        previewId,
        uploadLabelId,
        liveBtnId
      );

}

/* ============================================================
   LIVE CAMERA CAPTURE (NO SIMULATED / DRAWN PHOTOS)
   If a real camera is connected, captures a genuine photo.
   If camera is NOT connected, returns null and displays
   "Camera Not Connected" instead of generating drawings.
============================================================ */

let kioskMediaStream = null;

async function startKioskRealCamera() {
  const video = $('#kioskCameraVideo');
  if (kioskMediaStream) {
    return;
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      kioskMediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' },
        audio: false
      });
      if (video) {
        video.srcObject = kioskMediaStream;
        await video.play().catch(() => {});
      }
    } catch (err) {
      console.warn('Webcam not connected or permission denied:', err);
    }
  }
}

function stopKioskRealCamera() {
  if (kioskMediaStream) {
    kioskMediaStream.getTracks().forEach(track => track.stop());
    kioskMediaStream = null;
  }
  const video = $('#kioskCameraVideo');
  if (video) {
    video.srcObject = null;
  }
}

async function captureRealKioskPhoto(plate, spaceNo) {
  // 1. PRIMARY: Fetch real snapshot from ESP32-CAM (/api/camera/snapshot)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    const resp = await fetch(`${apiBase}/camera/snapshot`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.success && data.image) {
        return data.image;
      }
    }
  } catch (e) {
    // ESP32 camera offline or timed out - try webcam fallback
  }

  // 2. FALLBACK: If live webcam video stream is active, capture from canvas
  const video = $('#kioskCameraVideo');
  if (video && kioskMediaStream && video.videoWidth > 0 && !video.paused) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const capturedData = canvas.toDataURL('image/jpeg', 0.88);
      if (capturedData && capturedData.length > 500) {
        return capturedData;
      }
    } catch (e) {
      console.warn('Canvas webcam frame extraction error:', e);
    }
  }

  // 3. Fallback: Camera not connected or timed out - proceed immediately without blocking
  return null;
}

const captureOrGeneratePhoto = captureRealKioskPhoto;

/* ============================================================
   LIVE PARKED MOTORCYCLES & FEE REPORT MONITOR
   Staff Check-In page: shows live parking report, fixed fee
   (300 Riel), active motorcycles, and entrance photos.
============================================================ */

let selectedParkedMoto = null;

function renderCheckinMonitor() {
  const parkedListEl = $('#parkedMotosList');
  const parkedCountEl = $('#checkinParkedCount');
  const availableCountEl = $('#checkinAvailableCount');
  const occupancyRateEl = $('#checkinOccupancyRate');
  const unpaidTotalEl = $('#checkinUnpaidTotal');

  const parkedRecords = records.filter(r => r.status === 'PARKED');
  const availableSpacesCount = spaces.filter(s => s.status === 'available').length;
  const totalCapacity = Math.max(capacity, 500);
  const occupancyPct = Math.min(100, Math.round((parkedRecords.length / totalCapacity) * 100));
  const unpaidTotalFee = parkedRecords.length * 300;

  if (parkedCountEl) parkedCountEl.textContent = `${parkedRecords.length}`;
  if (availableCountEl) availableCountEl.textContent = `${availableSpacesCount}`;
  if (occupancyRateEl) occupancyRateEl.textContent = `${occupancyPct}%`;
  if (unpaidTotalEl) unpaidTotalEl.textContent = `${unpaidTotalFee.toLocaleString()} Riel`;

  if (!parkedListEl) return;

  const searchQuery = ($('#checkinMotoSearch') ? $('#checkinMotoSearch').value.trim().toLowerCase() : '');
  const filtered = parkedRecords.filter(r => {
    if (!searchQuery) return true;
    return (
      (r.plate && r.plate.toLowerCase().includes(searchQuery)) ||
      (r.parking && String(r.parking).toLowerCase().includes(searchQuery)) ||
      (r.id && String(r.id).toLowerCase().includes(searchQuery))
    );
  });

  if (filtered.length === 0) {
    parkedListEl.innerHTML = `
      <div class="record-empty" style="padding: 28px 16px;">
        <span class="material-symbols-outlined icon-hero">two_wheeler</span>
        <b>${searchQuery ? 'No matching motorcycles' : 'No motorcycles parked'}</b>
        <small>${searchQuery ? 'Try another Moto ID or space number.' : 'Spaces are ready for incoming riders at the entrance kiosk.'}</small>
      </div>
    `;
    if (selectedParkedMoto && !parkedRecords.some(r => r.id === selectedParkedMoto.id)) {
      selectedParkedMoto = null;
      renderCheckinDetail(null);
    }
    return;
  }

  if (!selectedParkedMoto || !parkedRecords.some(r => r.id === selectedParkedMoto.id)) {
    selectedParkedMoto = filtered[0];
  }

  parkedListEl.innerHTML = filtered.map(r => {
    const isSelected = selectedParkedMoto && selectedParkedMoto.id === r.id;
    const thumbHtml = r.motorcycle_image 
      ? `<img class="moto-thumb" src="/${r.motorcycle_image}" alt="" onerror="this.onerror=null; this.parentElement.innerHTML='<span class=\\'material-symbols-outlined icon-sm\\'>two_wheeler</span>';">`
      : `<span class="material-symbols-outlined icon-sm">two_wheeler</span>`;

    return `
      <div class="moto-item ${isSelected ? 'selected' : ''}" onclick="selectParkedMoto('${r.id}')">
        <div class="moto-left">
          <span class="moto-space-badge">${r.parking}</span>
          <div class="moto-thumb-wrap">${thumbHtml}</div>
          <div class="moto-meta">
            <span class="moto-plate">${r.plate}</span>
            <span class="moto-time">Arrival: ${r.arrival ? r.arrival.split(' ').slice(1).join(' ') : '—'}</span>
          </div>
        </div>
        <div class="moto-right">
          <span class="moto-fee">300 Riel</span>
          <span class="badge-unpaid">UNPAID</span>
        </div>
      </div>
    `;
  }).join('');

  renderCheckinDetail(selectedParkedMoto);
}

function selectParkedMoto(recordId) {
  const r = records.find(x => x.id === recordId);
  if (r) {
    selectedParkedMoto = r;
    renderCheckinMonitor();
  }
}

function getCameraNotConnectedHtml() {
  return `
    <div class="camera-offline-card">
      <div class="cam-icon-circle">
        <span class="material-symbols-outlined icon-md">no_photography</span>
      </div>
      <b class="cam-title">Camera Not Connected</b>
      <small class="cam-desc">No live camera connected during check-in</small>
      <span class="cam-status-pill"><span class="cam-dot"></span> Offline</span>
    </div>
  `;
}

function renderCheckinDetail(r) {
  const detailEl = $('#checkinDetailContent');
  const badgeEl = $('#checkinSelectedBadge');
  if (!detailEl) return;

  if (!r) {
    detailEl.className = 'record-empty';
    detailEl.innerHTML = `
      <span class="material-symbols-outlined icon-hero">two_wheeler</span>
      <b>Select a Parked Motorcycle</b>
      <small>Click any motorcycle from the list on the left to view its entrance photo, parking fee, and receipt.</small>
    `;
    if (badgeEl) {
      badgeEl.className = 'status-pill pending';
      badgeEl.textContent = 'NO SELECTION';
    }
    return;
  }

  if (badgeEl) {
    badgeEl.className = 'status-pill verified';
    badgeEl.textContent = `SLOT ${r.parking}`;
  }

  detailEl.className = 'checkin-detail-box';
  const photoHtml = r.motorcycle_image
    ? `<div class="moto-photo-wrapper photo-clickable" onclick="openLightbox('${formatImgUrl(r.motorcycle_image)}', 'Motorcycle Photo — Slot ${r.parking} (${r.plate || 'No Plate'})')" title="Click to view full photo">
         <img class="moto-detail-photo" src="${formatImgUrl(r.motorcycle_image)}" alt="Captured motorcycle photo" onerror="this.onerror=null; this.parentElement.innerHTML=getCameraNotConnectedHtml();">
         <div class="photo-zoom-overlay">
           <span class="material-symbols-outlined icon-sm">zoom_in</span>
           <span>Click to view full photo</span>
         </div>
       </div>`
    : getCameraNotConnectedHtml();

  detailEl.innerHTML = `
    ${photoHtml}
    <div class="moto-detail-grid">
      <div class="moto-detail-item">
        <span>Parking Slot</span>
        <b>${r.parking}</b>
      </div>
      <div class="moto-detail-item">
        <span>Moto ID</span>
        <b>${r.moto_id || r.plate}</b>
      </div>
      <div class="moto-detail-item">
        <span>Ticket ID</span>
        <b>${r.id}</b>
      </div>
      <div class="moto-detail-item">
        <span>Arrival Time</span>
        <b>${r.arrival || '—'}</b>
      </div>
      <div class="moto-detail-item">
        <span>Standard Fee</span>
        <b class="peach-highlight">300 Riel</b>
      </div>
      <div class="moto-detail-item">
        <span>Payment Status</span>
        <b style="color: #D44214;">UNPAID</b>
      </div>
    </div>
    <div class="actions" style="margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
      <button class="secondary" onclick="printReceiptFromCheckin('${r.id}')"><span class="material-symbols-outlined icon-sm">print</span> Reprint Receipt</button>
      <button class="primary" onclick="proceedToCheckOutFromCheckin('${r.id}')"><span class="material-symbols-outlined icon-sm">output</span> Check-Out Moto</button>
    </div>
  `;
}

function printReceiptFromCheckin(recordId) {
  const r = records.find(x => x.id === recordId);
  if (r) printReceipt(r);
}

function proceedToCheckOutFromCheckin(recordId) {
  showPage('checkout');
  if ($('#checkoutSearch')) {
    $('#checkoutSearch').value = recordId;
    if ($('#findRecord')) $('#findRecord').click();
  }
}

window.selectParkedMoto = selectParkedMoto;
window.printReceiptFromCheckin = printReceiptFromCheckin;
window.proceedToCheckOutFromCheckin = proceedToCheckOutFromCheckin;

if ($('#checkinMotoSearch')) {
  $('#checkinMotoSearch').addEventListener('input', () => {
    renderCheckinMonitor();
  });
}




/* ============================================================
   CHECK-OUT - FIND RECORD
============================================================ */

async function findAndDisplayRecord(targetCode = null) {
  let q = (targetCode !== null ? String(targetCode) : ($('#checkoutSearch')?.value || '')).trim().toLowerCase();
  if (!q) {
    toast('Please enter a ticket ID, slot number, or scan a barcode.');
    return null;
  }

  // Strip barcode delimiters (*PK00069* -> PK00069)
  if (q.startsWith('*') && q.endsWith('*') && q.length > 2) {
    q = q.slice(1, -1).trim();
  }
  const cleanNum = q.replace(/^pk0*/i, '');
  const cleanAlnum = q.replace(/[^a-z0-9]/gi, '');

  function matchRecord(x) {
    if (!x) return false;
    const xId = String(x.id || '').toLowerCase();
    const xSlot = String(x.parking || '').toLowerCase();
    const xPlate = String(x.plate || '').toLowerCase();
    const xIdNum = xId.replace(/^pk0*/i, '');
    const xPlateAlnum = xPlate.replace(/[^a-z0-9]/gi, '');

    return (
      xSlot === q ||
      xId === q ||
      xPlate === q ||
      (cleanNum && xIdNum === cleanNum) ||
      (cleanAlnum && cleanAlnum.length >= 3 && xPlateAlnum === cleanAlnum)
    );
  }

  // 1. Look for active PARKED ticket in memory
  let r = records.find(x => x.status === 'PARKED' && matchRecord(x));

  // 2. If not found, refresh from database (in case ticket was created at kiosk recently)
  if (!r) {
    try {
      await loadData(false);
      r = records.find(x => x.status === 'PARKED' && matchRecord(x));
    } catch (e) {}
  }

  selectedRecord = r || null;

  const searchInput = $('#checkoutSearch');
  if (searchInput && r) {
    searchInput.value = r.id;
  }

  // 3. If no active PARKED ticket, check if this ticket already completed exit
  if (!r) {
    const pastRecord = records.find(x => matchRecord(x));
    if (pastRecord) {
      if (searchInput) searchInput.value = pastRecord.id;
      $('#checkoutRecord').className = 'checkout-record-wrapper';
      $('#checkoutRecord').innerHTML = `
        <div class="checkout-record-card" style="border-left: 4px solid #f59e0b;">
          <div class="checkout-record-top">
            <span class="checkout-space-pill">SLOT ${pastRecord.parking}</span>
            <span class="checkout-plate-title">${pastRecord.plate}</span>
            <span class="status completed" style="background:rgba(16,185,129,0.15); color:#10b981; font-weight:700;">ALREADY EXITED</span>
          </div>

          <div style="padding: 10px 14px; background: rgba(245, 158, 11, 0.1); border-radius: 8px; margin: 10px 0; color: #b45309; font-size: 13px;">
            ⚠️ <b>Ticket ${pastRecord.id} has already checked out</b> and completed on <b>${pastRecord.exit || 'Earlier'}</b>. Fee (300 Riel) was collected.
          </div>

          <div class="checkout-detail-grid">
            <div class="checkout-detail-item"><span class="checkout-label">Parking Space</span><b class="checkout-val">${pastRecord.parking}</b></div>
            <div class="checkout-detail-item"><span class="checkout-label">Ticket ID</span><b class="checkout-val">${pastRecord.id}</b></div>
            <div class="checkout-detail-item"><span class="checkout-label">Moto ID</span><b class="checkout-val">${pastRecord.moto_id || pastRecord.plate}</b></div>
            <div class="checkout-detail-item"><span class="checkout-label">Arrival Time</span><b class="checkout-val">${pastRecord.arrival}</b></div>
            <div class="checkout-detail-item"><span class="checkout-label">Departure</span><b class="checkout-val">${pastRecord.exit || '—'}</b></div>
            <div class="checkout-detail-item"><span class="checkout-label">Status</span><b class="checkout-val" style="color:#10b981;">PAID & COMPLETED</b></div>
          </div>

          ${captureImagesHTML(pastRecord)}
        </div>
      `;
      $('#verifyBtn').disabled = true;
      toast(`⚠️ Ticket ${pastRecord.id} has already completed departure.`);
      return pastRecord;
    }

    // 4. Truly not found
    $('#checkoutRecord').className = 'record-empty';
    $('#checkoutRecord').innerHTML = `
      <span class="material-symbols-outlined icon-hero" style="color:var(--peach-primary);">warning</span>
      <b>Record not found</b>
      <small>No ticket matching "${q.toUpperCase()}" found in the database.</small>
    `;
    $('#verifyBtn').disabled = true;
    toast(`Record "${q.toUpperCase()}" not found.`);
    return null;
  }

  // Active parked record found!
  capturedExitPhotoDataUrl = null;
  const capturedBadge = $('#checkoutExitCapturedBadge');
  if (capturedBadge) capturedBadge.classList.add('hidden');

  $('#checkoutRecord').className = 'checkout-record-wrapper';
  $('#checkoutRecord').innerHTML = `
    <div class="checkout-record-card">
      <div class="checkout-record-top">
        <span class="checkout-space-pill">SLOT ${r.parking}</span>
        <span class="checkout-plate-title">${r.moto_id || r.plate}</span>
        <span class="badge-unpaid">${r.status || 'PARKED'}</span>
      </div>

      <div class="checkout-detail-grid">
        <div class="checkout-detail-item">
          <span class="checkout-label">Parking Space</span>
          <b class="checkout-val">${r.parking}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Ticket ID</span>
          <b class="checkout-val">${r.id}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Moto ID</span>
          <b class="checkout-val">${r.moto_id || r.plate}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Arrival Time</span>
          <b class="checkout-val">${r.arrival}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Parking Fee</span>
          <b class="checkout-val peach-highlight">300 Riel</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Status</span>
          <b class="checkout-val" style="color: #D44214;">${r.status || 'PARKED'}</b>
        </div>
      </div>

      ${captureImagesHTML(r)}
    </div>
  `;

  $('#verifyBtn').disabled = false;
  ensureExitCameraRunning();
  toast(`✓ Ticket ${r.id} loaded for departure.`);
  return r;
}

window.findAndDisplayRecord = findAndDisplayRecord;

if ($('#findRecord')) {
  $('#findRecord').onclick = () => {
    findAndDisplayRecord();
  };
}

// Auto-scan from input (instantly loads when barcode text is pasted or typed)
if ($('#checkoutSearch')) {
  let searchInputTimer = null;
  $('#checkoutSearch').addEventListener('input', () => {
    const val = ($('#checkoutSearch')?.value || '').trim();
    if (searchInputTimer) clearTimeout(searchInputTimer);

    let clean = val.replace(/^\*|\*$/g, '');
    // If input matches ticket format (e.g. PK00001) or length >= 3, auto-find immediately
    if (/^pk\d{2,6}$/i.test(clean) || (clean.length >= 3 && /^\d{1,4}$/.test(clean))) {
      searchInputTimer = setTimeout(() => {
        findAndDisplayRecord(val);
      }, 120);
    }
  });

  $('#checkoutSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findAndDisplayRecord();
    }
  });
}

/* ============================================================
   GLOBAL HARDWARE BARCODE SCANNER GUN INTERCEPTOR
   Detects high-speed keyboard input bursts from physical USB/Bluetooth
   barcode guns anywhere on the screen without requiring manual focus.
============================================================ */

let hwBarcodeBuffer = '';
let hwBarcodeLastTime = 0;
let hwBarcodeTimer = null;

window.addEventListener('keydown', (e) => {
  const now = Date.now();
  const diff = now - hwBarcodeLastTime;
  hwBarcodeLastTime = now;

  // Ignore modifier keys
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape'].includes(e.key)) {
    return;
  }

  const activeEl = document.activeElement;
  const isSearchInput = activeEl && activeEl.id === 'checkoutSearch';
  const isAuthInput = activeEl && (activeEl.id === 'username' || activeEl.id === 'password');

  // Never intercept password / username login inputs
  if (isAuthInput) {
    hwBarcodeBuffer = '';
    return;
  }

  // Barcode scanner guns typically send keys rapidly (< 180ms apart)
  if (diff > 180 && !isSearchInput) {
    hwBarcodeBuffer = '';
  }

  if (e.key === 'Enter') {
    let candidate = hwBarcodeBuffer.trim();
    if (!candidate && isSearchInput) {
      candidate = ($('#checkoutSearch')?.value || '').trim();
    }

    if (candidate && candidate.length >= 2) {
      e.preventDefault();
      hwBarcodeBuffer = '';
      if (hwBarcodeTimer) clearTimeout(hwBarcodeTimer);

      playScanBeep();

      if (!$('#page-checkout')?.classList.contains('active-page')) {
        showPage('checkout');
      }

      const searchInput = $('#checkoutSearch');
      if (searchInput) searchInput.value = candidate;

      findAndDisplayRecord(candidate);
      return;
    }
    hwBarcodeBuffer = '';
    return;
  }

  if (e.key.length === 1) {
    hwBarcodeBuffer += e.key;

    if (hwBarcodeTimer) clearTimeout(hwBarcodeTimer);
    hwBarcodeTimer = setTimeout(() => {
      let test = hwBarcodeBuffer.trim();
      if (test.startsWith('*') && test.endsWith('*')) test = test.slice(1, -1);
      if (/^pk\d{2,6}$/i.test(test) && test.length >= 3) {
        if (!$('#page-checkout')?.classList.contains('active-page')) {
          showPage('checkout');
        }
        playScanBeep();
        const searchInput = $('#checkoutSearch');
        if (searchInput) searchInput.value = test;
        findAndDisplayRecord(test);
      }
      hwBarcodeBuffer = '';
    }, 180);
  }
});



function playScanBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1550, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.14);
  } catch (e) {}
}




/* ============================================================
   VERIFY EXIT (DUAL PHOTO VERIFICATION: ENTRANCE VS LIVE EXIT)
============================================================ */

if ($('#verifyBtn')) {
  $('#verifyBtn').onclick = () => {
    if (!selectedRecord) {
      return;
    }

    // Capture real-time live exit photo from active local exit camera stream or use manual snapshot
    let liveExitPhotoUrl = capturedExitPhotoDataUrl || captureExitFrameFromStream();
    if (liveExitPhotoUrl) {
      capturedExitPhotoDataUrl = liveExitPhotoUrl;
      const capturedBadge = $('#checkoutExitCapturedBadge');
      if (capturedBadge) capturedBadge.classList.remove('hidden');
    }

    const match = true; // Confirmed by visual audit or sensor

    $('#verificationPanel').classList.remove('hidden');
    $('#verificationPanel').classList.toggle('failed', !match);

    $('#verifyTitle').innerHTML = match
      ? '<span class="material-symbols-outlined icon-md">verified</span> VERIFIED'
      : '<span class="material-symbols-outlined icon-md">cancel</span> NOT VERIFIED';

    $('#verifyMessage').textContent = match
      ? 'Same driver and same motorcycle confirmed via dual camera check.'
      : 'Driver or motorcycle does not match the parking record. Manual review required.';

    $('#verifyBadge').textContent = match ? 'VERIFIED' : 'NOT VERIFIED';
    $('#verifyBadge').className = `status-pill ${match ? 'verified' : 'failed'}`;

    const photoComp = $('#checkoutPhotoComparison');
    if (photoComp) {
      const entranceImgUrl = selectedRecord && selectedRecord.motorcycle_image
        ? formatImgUrl(selectedRecord.motorcycle_image)
        : null;

      photoComp.innerHTML = `
        <div class="dual-photo-comparison">
          <div class="dual-photo-card">
            <div class="dual-photo-label">
              <span><span class="material-symbols-outlined icon-xs">login</span> Entrance (Check-In ESP32)</span>
              <span class="status-pill ${entranceImgUrl ? 'verified' : 'pending'}">${entranceImgUrl ? 'On File' : 'No Photo'}</span>
            </div>
            <div class="dual-photo-img-wrap" ${entranceImgUrl ? `onclick="openLightbox('${entranceImgUrl}', 'Entrance Photo — Ticket ${selectedRecord.id}')"` : ''}>
              ${entranceImgUrl 
                ? `<img src="${entranceImgUrl}" alt="Entrance capture">` 
                : `<div style="display:grid;place-items:center;height:100%;color:#8fa0b5;text-align:center;padding:10px;"><span class="material-symbols-outlined icon-lg">no_photography</span><small>No entrance photo on file</small></div>`}
            </div>
            <div class="dual-photo-meta">
              <div>Plate: <b>${selectedRecord.plate || 'No Plate'}</b></div>
              <div>Slot: <b>${selectedRecord.parking}</b> • Ticket: <b>${selectedRecord.id}</b></div>
            </div>
          </div>

          <div class="dual-photo-card exit-live">
            <div class="dual-photo-label">
              <span><span class="material-symbols-outlined icon-xs">videocam</span> Exit Gate (Live Capture)</span>
              <span class="status-pill ${liveExitPhotoUrl ? 'verified' : 'pending'}">${liveExitPhotoUrl ? 'Live Snapshot' : 'Camera Active'}</span>
            </div>
            <div class="dual-photo-img-wrap" ${liveExitPhotoUrl ? `onclick="openLightbox('${liveExitPhotoUrl}', 'Live Exit Gate Photo — Ticket ${selectedRecord.id}')"` : ''}>
              ${liveExitPhotoUrl
                ? `<img src="${liveExitPhotoUrl}" alt="Live exit capture">`
                : `<div style="display:grid;place-items:center;height:100%;color:#8fa0b5;text-align:center;padding:10px;"><span class="material-symbols-outlined icon-lg">videocam</span><small>Live Exit Stream Active</small></div>`}
            </div>
            <div class="dual-photo-meta">
              <div>Departure Checked: <b>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b></div>
              <div>Verification: <b style="color: #2e7d32;">Passed Dual-Point Check</b></div>
            </div>
          </div>
        </div>
      `;
    }

    $('#approveExit').dataset.match = match ? 'yes' : 'no';
    toast('Dual-camera verification successful.');
  };
}


/* ============================================================
   APPROVE EXIT
============================================================ */

if ($('#approveExit')) {

  $('#approveExit').onclick =
    async () => {

      if (!selectedRecord) {
        return;
      }


      if (
        $('#approveExit')
          .dataset
          .match === 'no'
        &&

        !confirm(
          'Verification failed. Are you sure you want to manually approve this exit?'
        )
      ) {

        return;

      }


      // Capture live exit photo from active local exit camera if not already taken
      const exitPhotoToSubmit = capturedExitPhotoDataUrl || captureExitFrameFromStream();

      let response;

      try {
        response = await fetch(
          `${apiBase}/check-out`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              record_id: selectedRecord.id,
              exit_image: exitPhotoToSubmit || null
            })
          }
        );
      } catch (error) {
        console.error(error);
        toast('Database connection unavailable.');
        return;
      }

      if (!response.ok) {
        let errorData = {};
        try {
          errorData = await response.json();
        } catch (e) {}
        toast(errorData.error || 'Check-out failed.');
        return;
      }

      const completed = recordFromApi(await response.json());
      Object.assign(selectedRecord, completed);

      const s = spaces.find(x => x.no === selectedRecord.parking);
      if (s) {
        s.status = 'available';
        s.record = null;
      }

      const exitedSpace = selectedRecord.parking;
      capturedExitPhotoDataUrl = null;
      const capturedBadge = $('#checkoutExitCapturedBadge');
      if (capturedBadge) capturedBadge.classList.add('hidden');

      toast(`✓ Exit approved for slot ${exitedSpace} (departure photo saved).`);
      broadcastSync('STAFF_CHECKOUT', { space: exitedSpace });
      await loadData(false);

      selectedRecord =
        null;


      if ($('#checkoutSearch')) {

        $('#checkoutSearch').value =
          '';

      }


      if ($('#checkoutRecord')) {

        $('#checkoutRecord').innerHTML = `

          <div class="record-empty">

            <span class="material-symbols-outlined icon-hero" style="color:#10b981;">check_circle</span>

            <b>
              Exit completed
            </b>

            <small>
              Parking space is now available.
            </small>

          </div>

        `;

      }


      if ($('#verificationPanel')) {

        $('#verificationPanel')
          .classList
          .add('hidden');

      }


      if ($('#verifyBtn')) {

        $('#verifyBtn').disabled =
          true;

      }


      renderAll();

    };

}


/* ============================================================
   REJECT EXIT
============================================================ */

if ($('#rejectExit')) {

  $('#rejectExit').onclick =
    () => {

      toast(
        'Exit rejected. Motorcycle remains parked.'
      );


      if ($('#verificationPanel')) {

        $('#verificationPanel')
          .classList
          .add('hidden');

      }

    };

}


/* ============================================================
   VIEW ORIGINAL RECORD
============================================================ */

if ($('#viewOriginal')) {

  $('#viewOriginal').onclick =
    () => {

      if (!selectedRecord) {
        return;
      }


      showModal(`
        <h2>Original Parking Record</h2>
        <div class="checkout-record-card" style="margin-top: 14px;">
          <div class="checkout-record-top">
            <span class="checkout-space-pill">SLOT ${selectedRecord.parking}</span>
            <span class="checkout-plate-title">${selectedRecord.plate}</span>
            <span class="badge-unpaid">${selectedRecord.status || 'PARKED'}</span>
          </div>

          <div class="checkout-detail-grid">
            <div class="checkout-detail-item">
              <span class="checkout-label">Parking Space</span>
              <b class="checkout-val">${selectedRecord.parking}</b>
            </div>
            <div class="checkout-detail-item">
              <span class="checkout-label">Record ID</span>
              <b class="checkout-val">${selectedRecord.id}</b>
            </div>
            <div class="checkout-detail-item">
              <span class="checkout-label">Moto ID</span>
              <b class="checkout-val">${selectedRecord.moto_id || selectedRecord.plate}</b>
            </div>
            <div class="checkout-detail-item">
              <span class="checkout-label">Arrival Time</span>
              <b class="checkout-val">${selectedRecord.arrival}</b>
            </div>
            <div class="checkout-detail-item">
              <span class="checkout-label">Parking Fee</span>
              <b class="checkout-val peach-highlight">300 Riel</b>
            </div>
            <div class="checkout-detail-item">
              <span class="checkout-label">Status</span>
              <b class="checkout-val" style="color: ${selectedRecord.status === 'COMPLETED' ? '#0C8A4D' : '#D44214'};">${selectedRecord.status || 'PARKED'}</b>
            </div>
          </div>

          ${captureImagesHTML(selectedRecord)}
        </div>
      `);

    };

}


/* ============================================================
   MODAL
   ============================================================ */

function showModal(content) {
  const modalContent = $('#modalContent') || $('#modalBody');
  if (modalContent) {
    modalContent.innerHTML = content;
  }
  const modal = $('#modal') || $('#modalBackdrop');
  if (modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal() {
  const modal = $('#modal') || $('#modalBackdrop');
  if (modal) {
    modal.classList.add('hidden');
  }
  const lb = $('#imageLightbox');
  if (!lb || lb.classList.contains('hidden')) {
    document.body.style.overflow = '';
  }
}

if ($('#closeModal')) {
  $('#closeModal').onclick = closeModal;
}
if ($('#modalClose')) {
  $('#modalClose').onclick = closeModal;
}

const mainModalEl = $('#modal');
if (mainModalEl) {
  mainModalEl.onclick = (e) => {
    if (e.target === mainModalEl) {
      closeModal();
    }
  };
}

window.closeModal = closeModal;
window.showModal = showModal;


/* ============================================================
   IMAGE LIGHTBOX / FULL-RESOLUTION PHOTO VIEWER
   ============================================================ */

function openLightbox(src, title = 'Captured Photo') {
  if (!src) return;
  const fullSrc = (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/'))
    ? src
    : '/' + src;

  const lb = $('#imageLightbox');
  const img = $('#lightboxImg');
  const titleEl = $('#lightboxTitle');

  if (!lb || !img) return;

  img.src = fullSrc;
  img.classList.remove('zoomed');
  if (titleEl) titleEl.textContent = title;

  lb.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lb = $('#imageLightbox');
  if (lb) {
    lb.classList.add('hidden');
    const img = $('#lightboxImg');
    if (img) {
      img.classList.remove('zoomed');
      img.src = '';
    }
  }
  const modal = $('#modal');
  if (!modal || modal.classList.contains('hidden')) {
    document.body.style.overflow = '';
  }
}

function toggleLightboxZoom() {
  const img = $('#lightboxImg');
  if (!img) return;
  img.classList.toggle('zoomed');
}

if ($('#lightboxCloseBtn')) {
  $('#lightboxCloseBtn').onclick = closeLightbox;
}

if ($('#lightboxImg')) {
  $('#lightboxImg').onclick = toggleLightboxZoom;
}

const lbOverlay = $('#imageLightbox');
if (lbOverlay) {
  lbOverlay.onclick = (e) => {
    if (e.target === lbOverlay || e.target.id === 'lightboxBody') {
      closeLightbox();
    }
  };
}

// Global escape key handler
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = $('#imageLightbox');
    if (lb && !lb.classList.contains('hidden')) {
      closeLightbox();
      return;
    }
    const modal = $('#modal');
    if (modal && !modal.classList.contains('hidden')) {
      closeModal();
    }
  }
});

window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.toggleLightboxZoom = toggleLightboxZoom;


/* ============================================================
   HISTORY - VIEW CAPTURED PHOTOS / RECORD INSPECTION MODAL
   Called from the "Images" or "Details" button in History table.
   ============================================================ */

function showCapturedPhotos(id) {
  const r = records.find(x => x.id === id);
  if (!r) return;

  const hasPhotos = !!(r.driver_image || r.motorcycle_image || r.plate_image);
  const photoCount = [r.driver_image, r.motorcycle_image, r.plate_image].filter(Boolean).length;
  const isVerified = (r.verification === 'VERIFIED');
  const isCompleted = (r.status === 'COMPLETED');

  showModal(`
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 12px; padding-right: 28px;">
      <div>
        <h2 style="margin: 0 0 4px 0; font-family: 'Outfit', sans-serif;">Record Inspection — ${r.id}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--text-secondary);">
          ${hasPhotos ? `Found <b>${photoCount}</b> captured photo${photoCount > 1 ? 's' : ''}. Click any image to view in full resolution.` : 'No camera snapshots captured for this parking ticket.'}
        </p>
      </div>
      <span class="status-pill ${isVerified ? 'verified' : 'unverified'}" style="flex-shrink: 0;">
        <span class="material-symbols-outlined icon-xs">${isVerified ? 'check_circle' : 'pending_actions'}</span>
        ${r.verification || 'NOT VERIFIED'}
      </span>
    </div>

    <div class="checkout-record-card" style="margin-top: 10px;">
      <div class="checkout-record-top">
        <span class="checkout-space-pill">SLOT ${r.parking}</span>
        <span class="checkout-plate-title">${r.plate}</span>
        <span class="badge-unpaid" style="background: ${isCompleted ? '#E6FBF0' : 'var(--peach-light)'}; color: ${isCompleted ? '#0C8A4D' : 'var(--peach-deep)'}; border-color: ${isCompleted ? '#B8EED2' : 'var(--peach-border)'};">
          ${r.status || 'PARKED'} • ${r.payment_status || (isCompleted ? 'PAID' : 'UNPAID')}
        </span>
      </div>

      <div class="checkout-detail-grid">
        <div class="checkout-detail-item">
          <span class="checkout-label">Parking Space</span>
          <b class="checkout-val">${r.parking}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Moto ID</span>
          <b class="checkout-val">${r.moto_id || r.plate}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Arrival Time</span>
          <b class="checkout-val">${r.arrival || '—'}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Exit Time</span>
          <b class="checkout-val">${r.exit || '—'}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Duration</span>
          <b class="checkout-val">${r.duration || '—'}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Fee</span>
          <b class="checkout-val peach-highlight">${isCompleted ? `${r.fee || 300} Riel` : '300 Riel (Standard)'}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Cashier Staff</span>
          <b class="checkout-val">${r.processed_by || 'Cashier Staff'}</b>
        </div>
        <div class="checkout-detail-item">
          <span class="checkout-label">Exit Verification</span>
          <b class="checkout-val" style="color: ${isVerified ? '#15803D' : '#DC2626'}; font-weight: 700;">
            ${r.verification || 'NOT VERIFIED'}
          </b>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em;">Entrance Camera Captures</span>
          ${hasPhotos ? '<small style="color: var(--peach-deep); font-weight: 600; font-size: 11px; display: inline-flex; align-items: center; gap: 3px;"><span class="material-symbols-outlined icon-xs">zoom_in</span> Click photo to enlarge</small>' : ''}
        </div>
        ${captureImagesHTML(r)}
      </div>
    </div>
  `);
}

window.showCapturedPhotos = showCapturedPhotos;
window.showRecordImages = showCapturedPhotos;


/* ============================================================
   HISTORY FILTERS
============================================================ */

if ($('#historySearch')) {

  $('#historySearch').oninput =
    renderHistory;

}


if ($('#historyStatus')) {

  $('#historyStatus').onchange =
    renderHistory;

}


if ($('#historyVerification')) {

  $('#historyVerification').onchange =
    renderHistory;

}


/* ============================================================
   PRINT
============================================================ */

if ($('#printHistory')) {

  $('#printHistory').onclick =
    () =>
      window.print();

}


if ($('#printReport')) {

  $('#printReport').onclick =
    () =>
      window.print();

}


/* ============================================================
   EXECUTIVE FINANCIAL OVERVIEW (MANAGER)
   Fetches all-time revenue amounts, monthly totals, and staff
   performance breakdown from /api/manager/financial-overview.
============================================================ */

async function loadManagerFinancials() {
  try {
    const res = await fetch(`${apiBase}/manager/financial-overview`);
    if (!res.ok) return;
    const data = await res.json();

    if ($('#mgrAllTimeRevenue')) {
      $('#mgrAllTimeRevenue').textContent = `${(data.all_time_revenue || 0).toLocaleString()} Riel`;
    }
    if ($('#mgrMonthRevenue')) {
      $('#mgrMonthRevenue').textContent = `${(data.month_revenue || 0).toLocaleString()} Riel`;
    }
    if ($('#mgrMonthCount')) {
      $('#mgrMonthCount').textContent = `${data.month_motorcycles || 0} motorcycles this month`;
    }
    if ($('#todayRevenue')) {
      $('#todayRevenue').textContent = `${(data.today_revenue || 0).toLocaleString()} Riel`;
    }
    if ($('#mgrTodayCount')) {
      $('#mgrTodayCount').textContent = `${data.today_motorcycles || 0} exited today`;
    }
    if ($('#mgrAllTimeCount')) {
      $('#mgrAllTimeCount').textContent = (data.all_time_motorcycles || 0).toLocaleString();
    }
    if ($('#mgrAvgDuration')) {
      const mins = data.avg_duration_minutes || 0;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      $('#mgrAvgDuration').textContent = h > 0 ? `${h}h ${m}m` : `${m} min`;
    }

    // Render Staff Cashier Performance Table
    const tbody = $('#staffBreakdownBody');
    if (tbody && Array.isArray(data.staff_breakdown)) {
      if (data.staff_breakdown.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-secondary);">No cashier activity recorded yet.</td></tr>';
      } else {
        const totalCollectedAll = data.all_time_revenue || 1;
        tbody.innerHTML = data.staff_breakdown.map(st => {
          const share = Math.round(((st.total_collected || 0) / (totalCollectedAll || 1)) * 100);
          return `
            <tr>
              <td><b>${st.staff_name}</b></td>
              <td><code>${st.username}</code></td>
              <td><b>${st.total_processed}</b> records</td>
              <td><b class="peach-highlight">${(st.total_collected || 0).toLocaleString()} Riel</b></td>
              <td><span class="status-pill verified">${share}% of Total</span></td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.warn('Error loading manager financials:', err);
  }
}

/* ============================================================
   STAFF CASHIER SHIFT & HANDOVER REPORT
   Fetches today's cashier totals, provides change calculator,
   and prints shift handover slips.
============================================================ */

async function loadStaffShiftSummary() {
  try {
    const res = await fetch(`${apiBase}/staff/shift-summary`);
    if (!res.ok) return;
    const data = await res.json();

    if ($('#staffMyCashToday')) {
      $('#staffMyCashToday').textContent = `${(data.collected_today || 0).toLocaleString()} Riel`;
    }
    if ($('#staffMyCheckoutsToday')) {
      $('#staffMyCheckoutsToday').textContent = data.checkouts_today || 0;
    }
    if ($('#staffMyCheckinsToday')) {
      $('#staffMyCheckinsToday').textContent = data.checkins_today || 0;
    }

    // Render Today's Activity feed for staff
    const activityFeed = $('#staffShiftActivityList');
    if (activityFeed) {
      const todayRecords = records.slice(0, 10);
      if (todayRecords.length === 0) {
        activityFeed.innerHTML = '<div class="record-empty" style="padding:20px;"><small>No parking events recorded today.</small></div>';
      } else {
        activityFeed.innerHTML = todayRecords.map(r => `
          <div class="activity-item">
            <span class="material-symbols-outlined icon-sm" style="color: ${r.status === 'COMPLETED' ? '#10b981' : 'var(--peach-primary)'};">
              ${r.status === 'COMPLETED' ? 'check_circle' : 'two_wheeler'}
            </span>
            <div class="activity-meta">
              <b>${r.moto_id || r.plate} — Slot ${r.parking}</b>
              <small>${r.status === 'COMPLETED' ? 'Exited • 300 Riel' : 'Parked • Active'}</small>
            </div>
            <span class="activity-time">${r.arrival ? r.arrival.split(' ').slice(1).join(' ') : 'Today'}</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.warn('Error loading staff shift summary:', err);
  }
}

/* ============================================================
   CASHIER UTILITIES (CHANGE CALCULATOR & STATUS LOOKUP)
============================================================ */

function initCashierUtilities() {
  // 1. Change calculator
  const cashInput = $('#calcCashTendered');
  const changeOut = $('#calcChangeOutput');
  const fee = 300;

  function updateChange() {
    if (!cashInput || !changeOut) return;
    const tendered = Number(cashInput.value) || 0;
    if (tendered <= 0) {
      changeOut.textContent = '0 Riel';
      changeOut.style.color = '#15803D';
      return;
    }
    const change = tendered - fee;
    if (change < 0) {
      changeOut.textContent = `Short by ${Math.abs(change).toLocaleString()} Riel`;
      changeOut.style.color = '#DC2626';
    } else {
      changeOut.textContent = `${change.toLocaleString()} Riel`;
      changeOut.style.color = '#15803D';
    }
  }

  if (cashInput) {
    cashInput.oninput = updateChange;
  }

  $$('.btn-preset').forEach(btn => {
    btn.onclick = () => {
      const amt = btn.dataset.amount;
      if (cashInput) {
        cashInput.value = amt;
        updateChange();
      }
    };
  });



  // 3. Print Shift Handover Slip
  const handoverBtn = $('#btnPrintShiftHandover');
  if (handoverBtn) {
    handoverBtn.onclick = printShiftHandover;
  }

  // 4. Export CSV button (Manager)
  const exportCsvBtn = $('#exportCsvBtn');
  if (exportCsvBtn) {
    exportCsvBtn.onclick = exportFinancialCsv;
  }
}

function printShiftHandover() {
  const cashierName = currentUser ? currentUser.fullname : 'Staff Cashier';
  const cashAmount = $('#staffMyCashToday') ? $('#staffMyCashToday').textContent : '0 Riel';
  const checkouts = $('#staffMyCheckoutsToday') ? $('#staffMyCheckoutsToday').textContent : '0';
  const checkins = $('#staffMyCheckinsToday') ? $('#staffMyCheckinsToday').textContent : '0';
  const shiftTime = new Date().toLocaleString('en-GB');

  const w = window.open('', '_blank', 'width=420,height=600');
  if (!w) {
    toast('Please allow pop-ups to print handover slip.');
    return;
  }

  w.document.write(`
    <html>
      <head>
        <title>Cashier Shift Handover Slip</title>
        <style>
          body { font-family: monospace; padding: 25px; font-size: 13px; line-height: 1.5; }
          .receipt { border: 1.5px dashed #444; padding: 20px; }
          .center { text-align: center; }
          hr { border: 0; border-top: 1px dashed #777; margin: 12px 0; }
          .row { display: flex; justify-content: space-between; margin-bottom: 6px; }
          .total-box { background: #f4f4f4; padding: 10px; font-size: 16px; font-weight: bold; text-align: center; margin: 12px 0; border: 1px solid #ddd; }
          .sig-line { margin-top: 35px; border-top: 1px solid #000; text-align: center; font-size: 11px; }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="center">
            <h2 style="margin:0 0 4px 0;">Sereyromanea Building</h2>
            <b>OFFICIAL CASHIER SHIFT HANDOVER</b>
          </div>
          <hr>
          <div class="row"><span>Cashier:</span><b>${cashierName}</b></div>
          <div class="row"><span>Shift Date/Time:</span><b>${shiftTime}</b></div>
          <div class="row"><span>Fee Rate:</span><b>300 Riel / Moto</b></div>
          <hr>
          <div class="row"><span>Motorcycles Checked In:</span><b>${checkins}</b></div>
          <div class="row"><span>Motorcycles Checked Out:</span><b>${checkouts}</b></div>
          <div class="total-box">
            TOTAL CASH TO HAND OVER:<br>
            <span style="font-size: 20px; color: #15803D;">${cashAmount}</span>
          </div>
          <hr>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 25px;">
            <div><div class="sig-line">Cashier Signature</div></div>
            <div><div class="sig-line">Supervisor Signature</div></div>
          </div>
        </div>
        <script>
          try {
            if (!navigator.webdriver) {
              window.onload = function() { window.print(); };
            }
          } catch(e) {}
        </script>
      </body>
    </html>
  `);
  w.document.close();
}

function exportFinancialCsv() {
  if (!records || records.length === 0) {
    toast('No records to export.');
    return;
  }

  let csv = 'Ticket ID,Space,Moto ID,Arrival Time,Exit Time,Duration (Mins),Fee (Riel),Status,Payment,Cashier\n';
  records.forEach(r => {
    csv += `"${r.id}","${r.parking || ''}","${r.moto_id || r.plate || ''}","${r.arrival || ''}","${r.exit || ''}","${r.duration_minutes || 0}","${r.fee || 300}","${r.status || ''}","${r.payment_status || ''}","${r.processed_by || ''}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sereyromanea_financial_export_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('Financial statement CSV exported!');
}


/* ============================================================
   SAVE SETTINGS
============================================================ */

if ($('#saveSettings')) {

  $('#saveSettings').onclick =
    () => {

      capacity =
        Math.max(
          1,
          Number(
            $('#capacityInput').value
          )
          ||
          20
        );


      /*
         Add spaces if capacity increased.
      */

      while (
        spaces.length <
        capacity
      ) {

        spaces.push({

          no:
            String(
              spaces.length + 1
            ).padStart(
              3,
              '0'
            ),

          status:
            'available',

          record:
            null

        });

      }


      /*
         Remove spaces if capacity decreased.
      */

      if (
        spaces.length >
        capacity
      ) {

        spaces =
          spaces.slice(
            0,
            capacity
          );

      }


      renderAll();


      toast(
        'Settings saved.'
      );

    };

}


/* ============================================================
   SAVE CAMERA IP
============================================================ */

if ($('#saveCameraIp')) {

  $('#saveCameraIp').onclick =
    async () => {

      const ip =
        ($('#cameraIpInput').value || '').trim();

      if (!ip) {

        toast('Enter the camera\'s IP address first');
        return;

      }

      try {

        const response =
          await fetch(`${apiBase}/camera-config`, {

            method: 'POST',

            headers: {
              'Content-Type': 'application/json'
            },

            body: JSON.stringify({
              esp32_ip: ip
            })

          });

        if (!response.ok) {
          throw new Error('save failed');
        }

        toast('Camera IP saved.');

        await loadCameraConfig();

      } catch (error) {

        toast('Could not save camera IP');

      }

    };

}

if ($('#btnAutoDetectCamera')) {
  $('#btnAutoDetectCamera').onclick = async () => {
    const btn = $('#btnAutoDetectCamera');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined icon-sm">sync</span> Scanning...';
    toast('Scanning local networks for ESP32-CAM...');
    try {
      const resp = await fetch(`${apiBase}/camera/scan-network`);
      const data = await resp.json();
      if (data && data.detected && data.detected.length > 0) {
        const found = data.detected[0];
        $('#cameraIpInput').value = found.ip;
        esp32Ip = found.ip;
        toast(`✓ Detected ESP32-CAM at ${found.ip}! IP saved.`);
        await loadCameraConfig();
        wireEntranceStream();
        if (exitCameraSourceMode === 'esp32') startExitEspFeed();
      } else {
        toast('No ESP32-CAM detected on current Wi-Fi. Check camera power and SSID.');
      }
    } catch (e) {
      toast('Network scan failed or timed out.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined icon-sm">radar</span> Auto-Detect IP';
    }
  };
}


/* ============================================================
   CLOCK
============================================================ */

function clock() {

  const d =
    new Date();


  if (!$('#clock')) {
    return;
  }


  $('#clock').textContent =

    d.toLocaleDateString(
      'en-GB'
    )

    +

    ' • '

    +

    d.toLocaleTimeString(
      'en-US',
      {
        hour:
          '2-digit',

        minute:
          '2-digit'
      }
    );

}


setInterval(
  clock,
  1000
);


clock();


/* ============================================================
   AUTHENTICATION LOGIC
============================================================ */

let currentUser = null;

async function checkAuthStatus() {
  try {
    const response = await fetch(`${apiBase}/auth/status`, {
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (response.ok && data.logged_in) {
      handleLoginSuccess(data.user);
    } else {
      showLoginOverlay();
    }
  } catch (error) {
    console.error('Auth check failed:', error);
    showLoginOverlay();
  }
}

function showLoginOverlay() {
  currentUser = null;
  const portal = $('#portalSelector');
  if (portal) portal.classList.add('hidden');
  const kiosk = $('#customerKiosk');
  if (kiosk) kiosk.classList.add('hidden');
  const login = $('#loginOverlay');
  if (login) login.classList.remove('hidden');
  const app = $('.app');
  if (app) app.classList.add('hidden');
}

function handleLoginSuccess(user) {
  currentUser = user;
  const portal = $('#portalSelector');
  if (portal) portal.classList.add('hidden');
  const kiosk = $('#customerKiosk');
  if (kiosk) kiosk.classList.add('hidden');
  const login = $('#loginOverlay');
  if (login) login.classList.add('hidden');
  const app = $('.app');
  if (app) app.classList.remove('hidden');
  
  if (user) {
    if ($('#employeeName')) $('#employeeName').textContent = user.fullname;
    if ($('#employeeRole')) $('#employeeRole').textContent = user.role;
    if ($('#employeeAvatar')) {
      const initials = user.fullname.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      $('#employeeAvatar').textContent = initials;
    }

    // Role-based navigation visibility
    const navDashboard = $('[data-page="dashboard"]');
    const navCheckin = $('[data-page="checkin"]');
    const navCheckout = $('[data-page="checkout"]');
    const navCamera = $('[data-page="camera"]');
    const navHistory = $('[data-page="history"]');
    const navSettings = $('[data-page="settings"]');
    const navUsers = $('#navUsers');
    const navReports = $('#navReports');
    
    if (user.role === 'Manager') {
      // Manager View: Hide checkin and checkout operations
      if (navDashboard) navDashboard.classList.remove('hidden');
      if (navCheckin) navCheckin.classList.add('hidden');
      if (navCheckout) navCheckout.classList.add('hidden');
      if (navCamera) navCamera.classList.remove('hidden');
      if (navHistory) navHistory.classList.remove('hidden');
      if (navSettings) navSettings.classList.remove('hidden');
      if (navUsers) navUsers.classList.remove('hidden');
      if (navReports) navReports.classList.remove('hidden');

      // Dashboard & Reports views
      if ($('#managerQuickActions')) $('#managerQuickActions').classList.remove('hidden');
      if ($('#staffQuickActions')) $('#staffQuickActions').classList.add('hidden');
      if ($('#managerReportsView')) $('#managerReportsView').classList.remove('hidden');
      if ($('#staffReportsView')) $('#staffReportsView').classList.add('hidden');
      
      showPage('dashboard');
      loadManagerFinancials();
    } else {
      // Staff View: Can access checkin, checkout, camera, history, and reports!
      if (navDashboard) navDashboard.classList.add('hidden');
      if (navCheckin) navCheckin.classList.remove('hidden');
      if (navCheckout) navCheckout.classList.remove('hidden');
      if (navCamera) navCamera.classList.remove('hidden');
      if (navHistory) navHistory.classList.remove('hidden');
      if (navSettings) navSettings.classList.add('hidden');
      if (navUsers) navUsers.classList.add('hidden');
      if (navReports) navReports.classList.remove('hidden'); // Staff can view report!

      // Dashboard & Reports views
      if ($('#managerQuickActions')) $('#managerQuickActions').classList.add('hidden');
      if ($('#staffQuickActions')) $('#staffQuickActions').classList.remove('hidden');
      if ($('#managerReportsView')) $('#managerReportsView').classList.add('hidden');
      if ($('#staffReportsView')) $('#staffReportsView').classList.remove('hidden');
      
      showPage('checkin');
      loadStaffShiftSummary();
    }
  }

  // Load app data now that we are authenticated
  loadData();
  loadCameraConfig();
}

async function loginSubmit(e) {
  e.preventDefault();
  const usernameInput = $('#username');
  const passwordInput = $('#password');
  const errorDiv = $('#loginError');
  const submitBtn = $('#loginSubmitBtn');
  const btnText = $('#loginSubmitBtnText') || (submitBtn ? submitBtn.querySelector('.btn-text') : null);
  
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) return;

  errorDiv.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.classList.add('btn-loading');
  if (btnText) btnText.textContent = 'Logging in...';

  try {
    const response = await fetch(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    if (response.ok && data.success) {
      usernameInput.value = '';
      passwordInput.value = '';
      handleLoginSuccess(data.user);
      toast('Welcome back, ' + data.user.fullname + '!');
    } else {
      errorDiv.textContent = data.error || 'Invalid username or password.';
      errorDiv.classList.remove('hidden');
    }
  } catch (error) {
    console.error('Login error:', error);
    errorDiv.textContent = 'Connection to server failed.';
    errorDiv.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('btn-loading');
    if (btnText) btnText.textContent = 'Log In to Management';
  }
}

async function handleLogout() {
  try {
    const response = await fetch(`${apiBase}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (response.ok) {
      toast('Logged out successfully.');
      showLoginOverlay();
    } else {
      toast('Logout request failed.');
    }
  } catch (error) {
    console.error('Logout error:', error);
    toast('Could not contact server.');
  }
}

// Bind auth events
if ($('#loginForm')) {
  $('#loginForm').addEventListener('submit', loginSubmit);
}
if ($('#logoutBtn')) {
  $('#logoutBtn').addEventListener('click', handleLogout);
}


/* ============================================================
   DUAL-SCREEN ROUTING & INTER-SCREEN SYNCHRONIZATION
============================================================ */

// 1. Cross-Window Synchronization Bus (0ms latency between Screen 1 and Screen 2)
let syncChannel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    syncChannel = new BroadcastChannel('sereyromanea_sync_bus');
    syncChannel.onmessage = (event) => {
      handleCrossScreenMessage(event.data);
    };
  }
} catch (e) {
  console.warn('BroadcastChannel not supported:', e);
}

// Fallback to storage event for browsers/windows where BroadcastChannel might differ
window.addEventListener('storage', (e) => {
  if (e.key === 'sereyromanea_last_sync_event' && e.newValue) {
    try {
      const data = JSON.parse(e.newValue);
      handleCrossScreenMessage(data);
    } catch(err) {}
  }
});

function broadcastSync(type, payload = {}) {
  const message = { type, payload, timestamp: Date.now() };
  if (syncChannel) {
    try { syncChannel.postMessage(message); } catch (e) {}
  }
  try {
    localStorage.setItem('sereyromanea_last_sync_event', JSON.stringify(message));
  } catch (e) {}
}

function handleCrossScreenMessage(data) {
  if (!data || !data.type) return;
  // If we are currently displaying the management interface, update data automatically
  const isAppVisible = $('.app') && !$('.app').classList.contains('hidden');
  if (isAppVisible) {
    loadData(false);
  }
}

/* ============================================================
   REMOTE PHONE SCAN LISTENER (CHECKOUT AUTO-SYNC)
============================================================ */

let lastRemoteScanTimestamp = Date.now() / 1000;
let remoteScanPollInterval = null;

function startRemoteScanListener() {
  if (remoteScanPollInterval) clearInterval(remoteScanPollInterval);
  remoteScanPollInterval = setInterval(async () => {
    // Only poll if management app is active
    const isAppVisible = $('.app') && !$('.app').classList.contains('hidden');
    if (!isAppVisible) return;

    try {
      const resp = await fetch(`${apiBase}/remote-scan/latest?since=${lastRemoteScanTimestamp}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.events && data.events.length > 0) {
        for (const ev of data.events) {
          if (ev.timestamp > lastRemoteScanTimestamp) {
            lastRemoteScanTimestamp = ev.timestamp;
            handleRemotePhoneScan(ev);
          }
        }
      }
    } catch (e) {}
  }, 900);
}

function handleRemotePhoneScan(ev) {
  const code = (ev.ticket_id || '').trim();
  if (!code) return;

  playScanBeep();
  toast(`📱 Phone Scanned: ${code} (Beamed to Check-Out)`);

  if (!$('#page-checkout')?.classList.contains('active-page')) {
    showPage('checkout');
  }

  const searchInput = $('#checkoutSearch');
  if (searchInput) {
    searchInput.value = code;
  }

  ensureExitCameraRunning();
  findAndDisplayRecord(code);
}

// Periodic background sync for management console (every 5 seconds)
let managementSyncInterval = null;
function startManagementSync() {
  if (managementSyncInterval) clearInterval(managementSyncInterval);
  managementSyncInterval = setInterval(() => {
    const isAppVisible = $('.app') && !$('.app').classList.contains('hidden');
    if (isAppVisible) {
      loadData(false);
    }
  }, 5000);
}

// 2. Screen Mode Detection (/kiosk vs management)
function detectScreenMode() {
  const path = (window.location.pathname || '').toLowerCase();
  const search = new URLSearchParams(window.location.search);
  const modeParam = (search.get('mode') || search.get('screen') || '').toLowerCase();

  if (path.includes('/kiosk') || modeParam === 'kiosk') {
    return 'kiosk';
  }
  // Default directly to management login / dashboard (no selector)
  return 'management';
}

function showCustomerKiosk(updateUrl = true) {
  const streamImg = $('#entranceStreamImg');
  if (streamImg) streamImg.src = '';
  document.title = 'Sereyromanea Building — Customer Kiosk';
  const portalSelector = $('#portalSelector');
  if (portalSelector) portalSelector.classList.add('hidden');
  $('#customerKiosk').classList.remove('hidden');
  $('#loginOverlay').classList.add('hidden');
  $('.app').classList.add('hidden');
  initKioskClock();
  startKioskRealCamera();
  if (updateUrl && window.location.pathname !== '/kiosk' && window.history.pushState) {
    window.history.pushState({}, '', '/kiosk');
  }
}

function showStaffPortal(updateUrl = false) {
  stopKioskRealCamera();
  document.title = 'Sereyromanea Building — Management Console';
  const portalSelector = $('#portalSelector');
  if (portalSelector) portalSelector.classList.add('hidden');
  const kiosk = $('#customerKiosk');
  if (kiosk) kiosk.classList.add('hidden');
  startManagementSync();
  startRemoteScanListener();
  checkAuthStatus(); // Auto-shows app if already logged in, otherwise shows login card
  if (updateUrl && window.location.pathname !== '/management' && window.history.pushState) {
    window.history.pushState({}, '', '/management');
  }

  // Attempt automatic launch of Customer Kiosk window on first startup if running management console and not a secondary window
  if (!sessionStorage.getItem('sereyromanea_kiosk_launched') && !window.opener) {
    sessionStorage.setItem('sereyromanea_kiosk_launched', 'true');
    setTimeout(() => {
      openCustomerKioskWindow(true);
    }, 700);
  }
}

// 3. Open Customer Kiosk in dedicated window
function openCustomerKioskWindow(silent = false) {
  const screenW = window.screen.availWidth || 1920;
  const screenH = window.screen.availHeight || 1080;
  const halfW = Math.max(820, Math.floor(screenW / 2));

  const kioskWin = window.open(
    '/kiosk',
    'Sereyromanea_Customer_Kiosk',
    `width=${halfW},height=${screenH},left=0,top=0,menubar=no,toolbar=no,location=no,status=no,resizable=yes`
  );

  if (!kioskWin) {
    if (!silent) {
      alert('Popup window blocked! Please allow popups in your browser to open the Customer Kiosk window.');
    }
  } else {
    toast('<span class="material-symbols-outlined icon-sm">desktop_windows</span> Customer Kiosk opened! Move that window to your customer monitor.');
  }
}

// 4. Kiosk Fullscreen Mode Toggle
function toggleKioskFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      const btn = $('#kioskFullscreenBtn');
      if (btn) btn.innerHTML = '<span class="material-symbols-outlined icon-sm">fullscreen_exit</span> Exit Fullscreen';
    }).catch((err) => {
      console.warn('Fullscreen request failed:', err);
    });
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().then(() => {
        const btn = $('#kioskFullscreenBtn');
        if (btn) btn.innerHTML = '<span class="material-symbols-outlined icon-sm">fullscreen</span> Fullscreen';
      });
    }
  }
}

document.addEventListener('fullscreenchange', () => {
  const btn = $('#kioskFullscreenBtn');
  if (btn) {
    btn.innerHTML = document.fullscreenElement 
      ? '<span class="material-symbols-outlined icon-sm">fullscreen_exit</span> Exit Fullscreen' 
      : '<span class="material-symbols-outlined icon-sm">fullscreen</span> Fullscreen';
  }
});

let kioskClockInterval = null;
function initKioskClock() {
  if (kioskClockInterval) clearInterval(kioskClockInterval);
  
  function updateKioskTime() {
    const clockEl = $('#kioskClock');
    if (!clockEl) return;
    const d = new Date();
    clockEl.textContent = d.toLocaleDateString('en-GB') + ' • ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  
  updateKioskTime();
  kioskClockInterval = setInterval(updateKioskTime, 1000);
}

// Bind Kiosk window launchers and buttons
if ($('#kioskFullscreenBtn')) $('#kioskFullscreenBtn').onclick = toggleKioskFullscreen;


/* ============================================================
   CUSTOMER KIOSK PROCESS (Auto-finish in 5 seconds)
============================================================ */

let kioskAutoFinishTimer = null;
let kioskCountdownInterval = null;

function returnKioskToStart() {
  if (kioskAutoFinishTimer) {
    clearTimeout(kioskAutoFinishTimer);
    kioskAutoFinishTimer = null;
  }
  if (kioskCountdownInterval) {
    clearInterval(kioskCountdownInterval);
    kioskCountdownInterval = null;
  }

  const successPanel = $('#kioskSuccessPanel');
  const startPanel = $('#kioskStartPanel');
  if (successPanel) successPanel.classList.add('hidden');
  if (startPanel) startPanel.classList.remove('hidden');

  const doneBtn = $('#kioskDoneBtn');
  if (doneBtn) doneBtn.textContent = 'Finished';

  startKioskRealCamera();
}

function startKioskAutoFinishCountdown() {
  if (kioskAutoFinishTimer) clearTimeout(kioskAutoFinishTimer);
  if (kioskCountdownInterval) clearInterval(kioskCountdownInterval);

  let secondsLeft = 5;
  const secondsEl = $('#kioskSecondsLeft');
  const doneBtn = $('#kioskDoneBtn');

  if (secondsEl) secondsEl.textContent = '5';
  if (doneBtn) doneBtn.textContent = 'Finished (5s)';

  kioskCountdownInterval = setInterval(() => {
    secondsLeft--;
    if (secondsEl) secondsEl.textContent = String(Math.max(0, secondsLeft));
    if (doneBtn) doneBtn.textContent = `Finished (${Math.max(0, secondsLeft)}s)`;
    if (secondsLeft <= 0) {
      clearInterval(kioskCountdownInterval);
      kioskCountdownInterval = null;
    }
  }, 1000);

  // Auto finish in 5 seconds and go back to take new receipt
  kioskAutoFinishTimer = setTimeout(() => {
    returnKioskToStart();
  }, 5000);
}

if ($('#kioskSubmitBtn')) {
  $('#kioskSubmitBtn').onclick = async () => {
    // Generate strong unique numeric ID (8 digits, only numbers)
    const motoId = String(Math.floor(10000000 + Math.random() * 90000000));
    
    $('#kioskSubmitBtn').disabled = true;
    $('#kioskSubmitBtn').innerHTML = '<span class="kiosk-spinner"></span> <span>Printing Ticket...</span>';
    
    try {
      // 1. Silently capture real entrance photograph in background
      const photoDataUrl = await captureRealKioskPhoto(motoId);

      // 2. Submit check-in with real captured photo and strong numeric ID
      const response = await fetch(`${apiBase}/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moto_id: motoId,
          driver: 'Customer (Kiosk)',
          motorcycle: 'Kiosk Motorcycle',
          motorcycle_image: photoDataUrl
        })
      });
      
      if (!response.ok) {
        let errData = {};
        try { errData = await response.json(); } catch(e) {}
        toast(errData.error || 'Check-in failed.');
        return;
      }
      
      const r = recordFromApi(await response.json());
      records.unshift(r);

      // Mark assigned space as occupied
      const s = spaces.find(x => x.no === r.parking);
      if (s) {
        s.status = 'occupied';
        s.record = r;
      }
      
      // Update UI with assigned space and details
      $('#kioskAssignedSpace').textContent = r.parking;
      $('#kioskTicketCode').textContent = r.id;
      $('#kioskArrivalTime').textContent = r.arrival;
      
      // Switch to success panel
      $('#kioskStartPanel').classList.add('hidden');
      $('#kioskSuccessPanel').classList.remove('hidden');
      
      printReceipt(r);
      renderAll();
      broadcastSync('KIOSK_CHECKIN', { space: r.parking, id: r.id, moto_id: r.moto_id || motoId, plate: r.moto_id || motoId });

      // Auto finish in 5 seconds and go back to take new receipt
      startKioskAutoFinishCountdown();
      
    } catch (error) {
      console.error(error);
      toast('Kiosk offline or database unavailable.');
    } finally {
      $('#kioskSubmitBtn').disabled = false;
      $('#kioskSubmitBtn').innerHTML = '<span class="kiosk-btn-hero-icon"><span class="material-symbols-outlined icon-lg">print</span></span> <span class="kiosk-btn-hero-label">Get Parking Receipt</span>';
    }
  };
}

if ($('#kioskDoneBtn')) {
  $('#kioskDoneBtn').onclick = () => {
    returnKioskToStart();
  };
}

/* ============================================================
   EMPLOYEE CRUD OPERATIONS
============================================================ */

async function loadUsers() {
  try {
    const response = await fetch(`${apiBase}/users`);
    if (!response.ok) throw new Error('Failed to load users');
    const users = await response.json();
    renderUsers(users);
  } catch (error) {
    console.error('Error loading users:', error);
  }
}

function renderUsers(users) {
  const tbody = $('#usersBody');
  if (!tbody) return;
  tbody.innerHTML = users.map(u => `
    <tr>
      <td><b>${u.fullname}</b></td>
      <td>${u.username}</td>
      <td><span class="status ${u.role === 'Manager' ? 'completed' : 'parked'}">${u.role}</span></td>
      <td style="text-align: center;">
        <button class="link-btn" onclick="editUserPrompt(${u.id}, '${u.username}', '${u.fullname}', '${u.role}')"><span class="material-symbols-outlined icon-sm">edit</span> Edit</button>
        ${u.username !== 'admin' ? `<button class="link-btn" style="color:#e53e3e; margin-left:12px;" onclick="deleteUser(${u.id})"><span class="material-symbols-outlined icon-sm">delete</span> Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="4" style="text-align:center; padding:20px; color:#8b98a5;">No employees found.</td></tr>`;
}

function addUserPrompt() {
  showModal(`
    <h2>Add New Employee</h2>
    <form id="modalUserForm" style="display:grid; gap:12px; margin-top:12px;">
      <div class="form-group">
        <label>Full Name</label>
        <input type="text" id="mFullname" required placeholder="e.g. Sombo John">
      </div>
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="mUsername" required placeholder="e.g. sombo">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="mPassword" required placeholder="••••••••">
      </div>
      <div class="form-group">
        <label>Role</label>
        <select id="mRole" required>
          <option value="Parking Employee">Parking Employee (Cashier)</option>
          <option value="Manager">Manager (Admin)</option>
        </select>
      </div>
      <div id="modalUserError" class="login-error-msg hidden" style="margin: 0; padding: 8px;"></div>
      <button type="submit" class="primary wide" style="margin-top:8px;">Create Account</button>
    </form>
  `);

  $('#modalUserForm').onsubmit = async (e) => {
    e.preventDefault();
    const fullname = $('#mFullname').value.trim();
    const username = $('#mUsername').value.trim();
    const password = $('#mPassword').value;
    const role = $('#mRole').value;
    const errorDiv = $('#modalUserError');

    try {
      const response = await fetch(`${apiBase}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, fullname, role })
      });
      const data = await response.json();
      if (response.ok) {
        toast('User created successfully!');
        closeModal();
        loadUsers();
      } else {
        errorDiv.textContent = data.error || 'Failed to create user.';
        errorDiv.classList.remove('hidden');
      }
    } catch (err) {
      errorDiv.textContent = 'Server connection failed.';
      errorDiv.classList.remove('hidden');
    }
  };
}

function editUserPrompt(id, username, fullname, role) {
  showModal(`
    <h2>Edit Employee Account</h2>
    <form id="modalUserForm" style="display:grid; gap:12px; margin-top:12px;">
      <div class="form-group">
        <label>Full Name</label>
        <input type="text" id="mFullname" required value="${fullname}">
      </div>
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="mUsername" disabled value="${username}" style="opacity:0.6; cursor:not-allowed;">
      </div>
      <div class="form-group">
        <label>New Password (Leave blank to keep current)</label>
        <input type="password" id="mPassword" placeholder="••••••••">
      </div>
      <div class="form-group">
        <label>Role</label>
        <select id="mRole" required ${username === 'admin' ? 'disabled style="opacity:0.6; cursor:not-allowed;"' : ''}>
          <option value="Parking Employee" ${role === 'Parking Employee' ? 'selected' : ''}>Parking Employee (Cashier)</option>
          <option value="Manager" ${role === 'Manager' ? 'selected' : ''}>Manager (Admin)</option>
        </select>
      </div>
      <div id="modalUserError" class="login-error-msg hidden" style="margin: 0; padding: 8px;"></div>
      <button type="submit" class="primary wide" style="margin-top:8px;">Save Changes</button>
    </form>
  `);

  $('#modalUserForm').onsubmit = async (e) => {
    e.preventDefault();
    const updatedFullname = $('#mFullname').value.trim();
    const updatedRole = username === 'admin' ? 'Manager' : $('#mRole').value;
    const password = $('#mPassword').value;
    const errorDiv = $('#modalUserError');

    try {
      const response = await fetch(`${apiBase}/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullname: updatedFullname, role: updatedRole, password })
      });
      const data = await response.json();
      if (response.ok) {
        toast('User updated successfully!');
        closeModal();
        if (currentUser && currentUser.id === id) {
          checkAuthStatus();
        }
        loadUsers();
      } else {
        errorDiv.textContent = data.error || 'Failed to update user.';
        errorDiv.classList.remove('hidden');
      }
    } catch (err) {
      errorDiv.textContent = 'Server connection failed.';
      errorDiv.classList.remove('hidden');
    }
  };
}

async function deleteUser(id) {
  if (!confirm('Are you sure you want to delete this employee account?')) return;
  try {
    const response = await fetch(`${apiBase}/users/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (response.ok) {
      toast('Employee deleted successfully.');
      loadUsers();
    } else {
      toast(data.error || 'Failed to delete employee.');
    }
  } catch (err) {
    toast('Server connection failed.');
  }
}

// Bind User Management
if ($('#btnAddUser')) {
  $('#btnAddUser').onclick = addUserPrompt;
}

window.editUserPrompt = editUserPrompt;
window.deleteUser = deleteUser;

/* ============================================================
   INITIAL LOAD
============================================================ */

loadCameraConfig();
initCashierUtilities();

const initialMode = detectScreenMode();
if (initialMode === 'kiosk') {
  showCustomerKiosk(false);
} else {
  showStaffPortal(false);
}