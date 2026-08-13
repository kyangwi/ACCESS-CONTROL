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
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }
    });
    enrollVideo.srcObject = webcamStream;
    webcamOverlay.style.display = 'none';
    snapBtn.style.display = 'inline-flex';
    startWebcamBtn.innerHTML = '<i class="bi bi-stop-fill"></i> Stop Camera';
    showToast('Webcam started successfully. Align your face in center.', 'success');
  } catch (error) {
    console.error('Error starting webcam:', error);
    showToast('Could not access camera device.', 'danger');
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
document.addEventListener('DOMContentLoaded', () => {
  updateCount(existingCount);
  updateButtons(existingCount);

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', onFilesChange);
  bindDragDrop();

  // Webcam button events
  startWebcamBtn.addEventListener('click', () => {
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
});

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
    card.className = 'person-card';

    const details = document.createElement('div');
    details.className = 'person-details';

    const info = document.createElement('div');
    info.className = 'person-info';
    info.innerHTML = `<i class="fa-solid fa-user"></i><div class="name">${person.name}</div>`;

    const btn = document.createElement('button');
    btn.className = 'delete-btn';
    btn.type = 'button';
    btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Delete`;
    btn.addEventListener('click', () => deleteUser(person.id));

    details.append(info, btn);

    card.append(details);

    // Render gallery of all pictures for this person on the right
    if (person.all_avatars && person.all_avatars.length > 0) {
      const gallery = document.createElement('div');
      gallery.className = 'person-images-gallery';
      person.all_avatars.forEach(url => {
        const img = document.createElement('img');
        img.className = 'person-gallery-thumb';
        img.src = url;
        img.alt = person.name;
        gallery.appendChild(img);
      });
      card.appendChild(gallery);
    }

    peopleListEl.append(card);
  });

  totalUsersEl.textContent = list.length;
  totalUsersTextEl.textContent = list.length;
}

function applyFilters() {
  const q = searchInput.value.toLowerCase();
  const filtered = people.filter(p => p.name.toLowerCase().includes(q));
  renderPeople(filtered);
}

function deleteUser(id) {
  if (confirm(`Are you sure you want to delete user "${id}"? All enrolled face photos will be permanently deleted.`)) {
    fetch(`/api/people/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
      .then(res => {
        if (res.ok) {
          showToast(`Deleted user "${id}" successfully.`, 'success');
          fetchPeople();
        } else {
          showToast('Failed to delete user.', 'danger');
        }
      });
  }
}

searchInput.addEventListener('input', applyFilters);
fetchPeople();