// --- Element refs & config ---
const existingCount    = parseInt(document.getElementById('current-count').textContent || '0');
const minRequired      = parseInt(document.getElementById('drop-zone').dataset.minImages || '10');

const dropZone         = document.getElementById('drop-zone');
const fileInput        = document.getElementById('photos');
const previewContainer = document.getElementById('preview');
const countDisplay     = document.getElementById('current-count');
const actionBtns       = document.getElementById('action-buttons');
const saveBtn          = document.getElementById('save-btn');
const trainBtn         = document.getElementById('train-btn');
const toastEl          = document.getElementById('toast');
const trainingOverlay  = document.getElementById('training-overlay');
const addPeopleForm    = document.getElementById('add-people-form');

// Webcam Element refs
const startWebcamBtn   = document.getElementById('start-webcam-btn');
const snapBtn          = document.getElementById('snap-btn');
const enrollVideo      = document.getElementById('enroll-video');
const webcamOverlay    = document.getElementById('webcam-overlay');

let webcamStream       = null;
let capturedFilesList  = []; // Stores files captured via webcam

// --- Helpers ---
function showToast(msg, type='info'){
  toastEl.className = `toast show toast-${type}`;
  toastEl.textContent = msg;
  setTimeout(()=> {
    toastEl.classList.remove('show');
  }, 4000);
}

function updateCount(total){
  countDisplay.textContent = total;
}

function updateButtons(total){
  actionBtns.style.display = 'flex';
  trainBtn.style.display = 'inline-block';
  trainBtn.disabled = false;

  if (total < minRequired) {
    trainBtn.title = `Existing dataset is below ${minRequired} images. You can still retrain with the current dataset.`;
    trainBtn.textContent = 'Retrain Model';
  } else {
    trainBtn.title = 'Train the model with the current dataset.';
    trainBtn.textContent = 'Train Model';
  }
}

// Render preview from fileInput + captured snapshots
function renderAllPreviews() {
  previewContainer.innerHTML = '';
  
  // Render files from file input
  const inputFiles = Array.from(fileInput.files);
  const allFiles = [...inputFiles, ...capturedFilesList];

  allFiles.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.classList.add('thumb');
      previewContainer.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
}

// --- Event handlers ---
function onFilesChange(){
  const totalFilesCount = fileInput.files.length + capturedFilesList.length;
  const total = existingCount + totalFilesCount;

  if (total < minRequired) {
    showToast(`Need ${minRequired - total} more image(s) to train.`, 'warning');
  }

  updateCount(total);
  updateButtons(total);
  renderAllPreviews();
}

function bindDragDrop(){
  ['dragenter','dragover'].forEach(evt=>
    dropZone.addEventListener(evt, e=>{
      e.preventDefault();
      dropZone.classList.add('drag-over');
    })
  );
  ['dragleave','drop'].forEach(evt=>
    dropZone.addEventListener(evt, e=>{
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if(evt === 'drop'){
        fileInput.files = e.dataTransfer.files;
        onFilesChange();
      }
    })
  );
}

// --- Webcam capture logic ---
async function startWebcam() {
  console.log("addpeople.js: startWebcam() called, requesting camera stream");
  try {
    // Try to get stream with ideal constraints first
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });
    } catch (constraintErr) {
      console.warn('Webcam ideal constraints failed, falling back to simple video: true', constraintErr);
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
    }

    enrollVideo.srcObject = webcamStream;
    enrollVideo.play().catch(e => console.warn('Webcam play trigger error:', e));
    webcamOverlay.style.display = 'none';
    snapBtn.style.display = 'inline-flex';
    startWebcamBtn.innerHTML = '<i class="bi bi-stop-fill"></i> Stop Camera';
    showToast('Webcam started successfully. Align your face in center.', 'success');
  } catch (error) {
    console.error('Error starting webcam:', error);
    let errorMsg = 'Could not access camera device.';
    
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      errorMsg = 'Camera is in use by another tab or app (e.g. the Monitoring page). Please stop other streams and try again.';
    } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      errorMsg = 'Camera access denied. Please grant permission in your browser address bar.';
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      errorMsg = 'No camera device found on your system.';
    }
    
    showToast(errorMsg, 'danger');
  }
}

function stopWebcam() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    enrollVideo.srcObject = null;
    webcamStream = null;
  }
  webcamOverlay.style.display = 'flex';
  snapBtn.style.display = 'none';
  startWebcamBtn.innerHTML = '<i class="bi bi-play-fill"></i> Start Camera';
}

function captureSnapshot() {
  if (!webcamStream) return;

  const canvas = document.createElement('canvas');
  canvas.width = enrollVideo.videoWidth || 640;
  canvas.height = enrollVideo.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  
  // Mirror frame to match the mirrored display preview
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(enrollVideo, 0, 0, canvas.width, canvas.height);
  
  canvas.toBlob(blob => {
    const filename = `snapshot_${Date.now()}.jpg`;
    const file = new File([blob], filename, { type: 'image/jpeg' });
    
    // Add file to captured list
    capturedFilesList.push(file);
    showToast('Captured snapshot added to upload list.', 'success');
    
    // Synchronize to standard fileInput using DataTransfer API so it submits via Django Form
    syncFilesToInput();
    onFilesChange();
  }, 'image/jpeg', 0.95);
}

function syncFilesToInput() {
  const dataTransfer = new DataTransfer();
  
  // Stage existing files from file input
  Array.from(fileInput.files).forEach(f => {
    dataTransfer.items.add(f);
  });
  
  // Stage captured webcam files
  capturedFilesList.forEach(f => {
    dataTransfer.items.add(f);
  });
  
  fileInput.files = dataTransfer.files;
}

// --- Initialization ---
function init() {
  console.log("addpeople.js: init() executing");
  updateCount(existingCount);
  updateButtons(existingCount);

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', onFilesChange);
  bindDragDrop();

  // Webcam button events
  startWebcamBtn.addEventListener('click', () => {
    console.log("addpeople.js: start-webcam-btn clicked");
    if (webcamStream) {
      stopWebcam();
    } else {
      startWebcam();
    }
  });

  snapBtn.addEventListener('click', captureSnapshot);

  // Form submit -> Show biometric loader when retraining is triggered
  addPeopleForm.addEventListener('submit', (e) => {
    const submitBtn = e.submitter;
    if (submitBtn && submitBtn.value === 'train') {
      trainingOverlay.style.display = 'flex';
    }
  });

  // Show server-side Django flash messages
  document.querySelectorAll('.flash-messages .alert').forEach(el => {
    const type = el.classList.contains('alert-danger') ? 'danger' :
                 el.classList.contains('alert-success') ? 'success' :
                 el.classList.contains('alert-warning') ? 'warning' : 'info';
    showToast(el.textContent, type);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// --- Registered Users List logic ---
const peopleListEl = document.getElementById('peopleList');
const totalUsersEl = document.getElementById('totalUsers');
const totalUsersTextEl = document.getElementById('totalUsersText');
const searchInput = document.getElementById('searchInput');

let people = [];

function fetchPeople() {
  fetch('/api/people')
    .then(res => res.json())
    .then(data => {
      people = data;
      applyFilters();
    })
    .catch(err => {
      console.error('Failed to fetch people:', err);
      peopleListEl.innerHTML = '<p class="error">Failed to load people database.</p>';
    });
}

// --- Auto Role / Access Selection ---
const roleSelect = document.getElementById('role');
const accessSelect = document.getElementById('access_level');

if (roleSelect && accessSelect) {
  roleSelect.addEventListener('change', () => {
    if (roleSelect.value === 'Guest') {
      accessSelect.value = 'Restricted Access';
    } else if (roleSelect.value === 'Employee' || roleSelect.value === 'VIP') {
      accessSelect.value = 'Full Access';
    }
  });
}

function getRoleBadgeClass(role) {
  switch ((role || '').toLowerCase()) {
    case 'guest': return 'badge-guest';
    case 'vip': return 'badge-vip';
    case 'contractor': return 'badge-role';
    default: return 'badge-role';
  }
}

function getAccessBadgeClass(access) {
  switch ((access || '').toLowerCase()) {
    case 'full access': return 'badge-full-access';
    case 'restricted access': return 'badge-restricted-access';
    case 'blocked': return 'badge-blocked';
    default: return 'badge-full-access';
  }
}

// --- Profile Modal Elements & Logic ---
const profileModal        = document.getElementById('profileModal');
const closeProfileModal   = document.getElementById('closeProfileModal');
const modalAvatarImg      = document.getElementById('modalAvatarImg');
const modalPersonName     = document.getElementById('modalPersonName');
const modalBadges         = document.getElementById('modalBadges');
const modalRoleSelect     = document.getElementById('modalRoleSelect');
const modalAccessSelect   = document.getElementById('modalAccessSelect');
const modalSaveBtn        = document.getElementById('modalSaveBtn');
const modalDeleteBtn      = document.getElementById('modalDeleteBtn');
const modalPhotoCount     = document.getElementById('modalPhotoCount');
const modalGalleryGrid    = document.getElementById('modalGalleryGrid');

let activePerson = null;

function renderPeople(list) {
  peopleListEl.innerHTML = '';
  if (list.length === 0) {
    peopleListEl.innerHTML = '<p class="no-details-msg">No registered personnel found.</p>';
    totalUsersEl.textContent = 0;
    totalUsersTextEl.textContent = 0;
    return;
  }

  list.forEach(person => {
    const card = document.createElement('div');
    card.className = 'person-card clickable-card';
    card.title = `Click to view ${person.name}'s dedicated profile`;

    const details = document.createElement('div');
    details.className = 'person-details';

    const info = document.createElement('div');
    info.className = 'person-info';
    info.innerHTML = `<i class="fa-solid fa-user"></i><div class="name">${person.name}</div>`;

    const badges = document.createElement('div');
    badges.className = 'person-badges';
    badges.innerHTML = `
      <span class="badge ${getRoleBadgeClass(person.role)}"><i class="bi bi-person-badge"></i> ${person.role || 'Employee'}</span>
      <span class="badge ${getAccessBadgeClass(person.access_level)}"><i class="bi bi-shield-lock"></i> ${person.access_level || 'Full Access'}</span>
    `;

    details.append(info, badges);
    card.append(details);

    // Render single InsightFace face picture on the rightmost corner of the card
    const avatarWrapper = document.createElement('div');
    avatarWrapper.className = 'person-avatar-wrapper';
    if (person.avatar) {
      const img = document.createElement('img');
      img.className = 'person-single-face';
      img.src = person.avatar;
      img.alt = person.name;
      avatarWrapper.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'person-single-face placeholder-face';
      placeholder.innerHTML = '<i class="bi bi-person-fill"></i>';
      avatarWrapper.appendChild(placeholder);
    }
    card.appendChild(avatarWrapper);

    // Open dedicated profile on click
    card.addEventListener('click', () => openPersonProfile(person));

    peopleListEl.append(card);
  });

  totalUsersEl.textContent = list.length;
  totalUsersTextEl.textContent = list.length;
}

// --- Modal Elements ---
const modalAddPhotosInput = document.getElementById('modalAddPhotosInput');

function openPersonProfile(person) {
  activePerson = person;

  if (modalAvatarImg) {
    modalAvatarImg.src = person.avatar || '';
  }
  if (modalPersonName) {
    modalPersonName.textContent = person.name;
  }
  if (modalBadges) {
    modalBadges.innerHTML = `
      <span class="badge ${getRoleBadgeClass(person.role)}"><i class="bi bi-person-badge"></i> ${person.role || 'Employee'}</span>
      <span class="badge ${getAccessBadgeClass(person.access_level)}"><i class="bi bi-shield-lock"></i> ${person.access_level || 'Full Access'}</span>
    `;
  }
  if (modalRoleSelect) {
    modalRoleSelect.value = person.role || 'Employee';
  }
  if (modalAccessSelect) {
    modalAccessSelect.value = person.access_level || 'Full Access';
  }

  renderModalGalleryGrid();

  if (profileModal) {
    profileModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
}

function renderModalGalleryGrid() {
  if (!activePerson || !modalGalleryGrid || !modalPhotoCount) return;

  modalGalleryGrid.innerHTML = '';
  const photos = activePerson.all_avatars || [];
  modalPhotoCount.textContent = photos.length;

  if (photos.length === 0) {
    modalGalleryGrid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1; padding: 12px 0;">No enrolled photos remaining.</p>';
    return;
  }

  photos.forEach(imgUrl => {
    const item = document.createElement('div');
    item.className = 'profile-gallery-item';

    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = activePerson.name;
    img.addEventListener('click', () => window.open(imgUrl, '_blank'));

    const delBtn = document.createElement('button');
    delBtn.className = 'gallery-delete-btn';
    delBtn.type = 'button';
    delBtn.title = 'Delete photo';
    delBtn.innerHTML = '<i class="bi bi-trash-fill"></i>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSinglePhoto(activePerson.name, imgUrl);
    });

    item.append(img, delBtn);
    modalGalleryGrid.appendChild(item);
  });
}

function deleteSinglePhoto(name, imgUrl) {
  if (!confirm('Are you sure you want to delete this photo?')) return;

  const filename = imgUrl.split('/').pop();

  fetch('/api/people/delete-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, filename: filename })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showToast('Photo deleted successfully.', 'success');
        if (activePerson) {
          activePerson.all_avatars = data.all_avatars;
          activePerson.avatar = data.avatar;
          if (modalAvatarImg) modalAvatarImg.src = data.avatar || '';
          renderModalGalleryGrid();
        }
        fetchPeople();
      } else {
        showToast('Failed to delete photo: ' + (data.error || ''), 'danger');
      }
    })
    .catch(err => showToast('Error deleting photo: ' + err, 'danger'));
}

if (modalAddPhotosInput) {
  modalAddPhotosInput.addEventListener('change', (e) => {
    if (!activePerson || !e.target.files.length) return;

    const formData = new FormData();
    formData.append('name', activePerson.name);
    Array.from(e.target.files).forEach(file => {
      formData.append('photos', file);
    });

    fetch('/api/people/upload-photos', {
      method: 'POST',
      body: formData
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showToast(`Uploaded ${data.saved} new photo(s) for ${activePerson.name}.`, 'success');
          if (activePerson) {
            activePerson.all_avatars = data.all_avatars;
            activePerson.avatar = data.avatar;
            if (modalAvatarImg) modalAvatarImg.src = data.avatar || '';
            renderModalGalleryGrid();
          }
          fetchPeople();
        } else {
          showToast('Failed to upload photos: ' + (data.error || ''), 'danger');
        }
        // Reset file input value
        modalAddPhotosInput.value = '';
      })
      .catch(err => {
        showToast('Upload error: ' + err, 'danger');
        modalAddPhotosInput.value = '';
      });
  });
}

function closePersonProfileModal() {
  if (profileModal) {
    profileModal.style.display = 'none';
    document.body.style.overflow = '';
  }
  activePerson = null;
}

// Modal Event Listeners
if (closeProfileModal) {
  closeProfileModal.addEventListener('click', closePersonProfileModal);
}

if (profileModal) {
  profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) {
      closePersonProfileModal();
    }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && profileModal && profileModal.style.display === 'flex') {
    closePersonProfileModal();
  }
});

// Auto-switch access level when role is changed in modal
if (modalRoleSelect && modalAccessSelect) {
  modalRoleSelect.addEventListener('change', () => {
    if (modalRoleSelect.value === 'Guest') {
      modalAccessSelect.value = 'Restricted Access';
    } else if (modalRoleSelect.value === 'Employee' || modalRoleSelect.value === 'VIP') {
      modalAccessSelect.value = 'Full Access';
    }
  });
}

if (modalSaveBtn) {
  modalSaveBtn.addEventListener('click', () => {
    if (!activePerson) return;
    const newRole = modalRoleSelect.value;
    const newAccess = modalAccessSelect.value;

    fetch('/api/people/update-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: activePerson.name,
        role: newRole,
        access_level: newAccess
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showToast(`Updated access details for ${activePerson.name}.`, 'success');
          activePerson.role = newRole;
          activePerson.access_level = newAccess;
          if (modalBadges) {
            modalBadges.innerHTML = `
              <span class="badge ${getRoleBadgeClass(newRole)}"><i class="bi bi-person-badge"></i> ${newRole}</span>
              <span class="badge ${getAccessBadgeClass(newAccess)}"><i class="bi bi-shield-lock"></i> ${newAccess}</span>
            `;
          }
          fetchPeople();
        } else {
          showToast('Failed to update details: ' + (data.error || ''), 'danger');
        }
      })
      .catch(err => showToast('Update error: ' + err, 'danger'));
  });
}

if (modalDeleteBtn) {
  modalDeleteBtn.addEventListener('click', () => {
    if (!activePerson) return;
    if (confirm(`Are you sure you want to permanently delete user "${activePerson.name}" and all enrolled photos?`)) {
      fetch(`/api/people/${encodeURIComponent(activePerson.name)}`, {
        method: 'DELETE'
      })
        .then(res => {
          if (res.ok) {
            showToast(`Deleted user "${activePerson.name}" successfully.`, 'success');
            closePersonProfileModal();
            fetchPeople();
          } else {
            showToast('Failed to delete user.', 'danger');
          }
        })
        .catch(err => showToast('Delete error: ' + err, 'danger'));
    }
  });
}

function applyFilters() {
  const q = searchInput.value.toLowerCase();
  const filtered = people.filter(p => p.name.toLowerCase().includes(q));
  renderPeople(filtered);
}

searchInput.addEventListener('input', applyFilters);
fetchPeople();