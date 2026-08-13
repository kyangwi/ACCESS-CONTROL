import os
import json
import base64
import threading
import shutil
from datetime import datetime

from django.conf import settings
from django.http import JsonResponse, HttpResponse
from django.shortcuts import render, redirect
from django.contrib import messages
from django.views.decorators.csrf import csrf_exempt

from werkzeug.utils import secure_filename

import numpy as np
import cv2

from database import (
    init_db,
    save_face_record,
    get_records,
    get_kpi_counts,
    get_peak_hours,
    get_recent_incidents,
    save_incident,
    get_all_incidents,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATASET_DIR = str(settings.DATASET_DIR)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}
MIN_IMAGES_REQUIRED = 10

# Initialise the SQLite database tables on startup
init_db()

# ---------------------------------------------------------------------------
# Lazy-loaded ML globals (initialised on first /getdata/ call)
# ---------------------------------------------------------------------------
_analyzer = None
_classifier = None
_trackers = {}      # per-camera tracker: camera_id -> Tracker
_metric = None
_track_infos = {}   # per-camera track info: camera_id -> dict
_retraining_lock = threading.Lock()

MIN_RECOGNITION_COUNT = 1
MIN_CONFIDENCE = 0.45


def _get_ml_components():
    """Lazy-load heavy ML dependencies so Django can start without them."""
    global _analyzer, _classifier, _metric
    if _analyzer is None:
        try:
            from face_analyzer import FaceAnalyzer
            _analyzer = FaceAnalyzer()
        except Exception as exc:
            return None, None, None, f"FaceAnalyzer load failed: {exc}"

    # Load deep_sort metric (may be lightweight)
    if _metric is None:
        try:
            from deep_sort.deep_sort import nn_matching
            _metric = nn_matching.NearestNeighborDistanceMetric("cosine", 0.5)
        except Exception as exc:
            # metric is optional for basic tracking; log and continue
            return _analyzer, None, None, f"Metric load failed: {exc}"

    # Try to load classifier; if it fails, provide a dummy fallback so detections still work
    if _classifier is None:
        try:
            from classifier import FaceClassifier
            _classifier = FaceClassifier()
        except Exception as exc:
            # Create a lightweight dummy classifier that always returns unknown
            class _DummyClassifier:
                def __init__(self):
                    pass
                def classify(self, embedding):
                    return ('unknown', 'Unknown', 0.0)

            _classifier = _DummyClassifier()
            print(f"Classifier load failed, using dummy fallback: {exc}")
            return _analyzer, _classifier, _metric, None

    return _analyzer, _classifier, _metric, None




# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def background_retrain():
    if _retraining_lock.locked():
        return
    with _retraining_lock:
        try:
            from classifier import retrain_model
            retrain_model(_analyzer)
            print("Retraining complete")
        except Exception as e:
            print(f"Retraining failed: {e}")


def bb_intersection_over_union(boxA, boxB):
    xA = max(boxA[0], boxB[0])
    yA = max(boxA[1], boxB[1])
    xB = min(boxA[2], boxB[2])
    yB = min(boxA[3], boxB[3])
    interArea = max(0, xB - xA + 1) * max(0, yB - yA + 1)
    boxAArea = (boxA[2] - boxA[0] + 1) * (boxA[3] - boxA[1] + 1)
    boxBArea = (boxB[2] - boxB[0] + 1) * (boxB[3] - boxB[1] + 1)
    return interArea / float(boxAArea + boxBArea - interArea)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def home(request):
    return render(request, 'index.html')


def records_page(request):
    try:
        range_filter = request.GET.get('range', 'all')
        records_raw = get_records(time_range=range_filter)
        kpis = get_kpi_counts(records_raw)
        peak_hours = get_peak_hours(range_filter)
        recent_incidents_raw = get_recent_incidents(limit=5)

        # Pre-compute values that Django templates can't calculate
        r_pct = round(kpis['recognized'] / kpis['total'] * 100) if kpis['total'] else 0
        u_pct = round(kpis['unknown'] / kpis['total'] * 100) if kpis['total'] else 0
        max_peak = max((p['count'] for p in peak_hours), default=0)

        for p in peak_hours:
            p['bar_pct'] = round(p['count'] / max_peak * 100) if max_peak else 0

        for i, rec in enumerate(records_raw):
            parts = rec['Timestamp'].split(' ')
            rec['date_only'] = parts[0] if len(parts) > 0 else ''
            rec['time_only'] = parts[1] if len(parts) > 1 else ''
            rec['confidence_pct'] = round(rec['Confidence'] * 100, 1)
            rec['reference_id'] = f"F{500 + i + 1}E"

        for inc in recent_incidents_raw:
            parts = inc['timestamp'].split(' ')
            inc['time_only'] = parts[1] if len(parts) > 1 else ''

        return render(request, 'records.html', {
            'records': records_raw,
            'kpis': kpis,
            'r_pct': r_pct,
            'u_pct': u_pct,
            'peak_hours': peak_hours,
            'recent_incidents': recent_incidents_raw[:2],
            'active_range': range_filter,
            'timestamp': datetime.now().timestamp(),
        })
    except Exception as e:
        print(f"Error: {e}")
        return HttpResponse(f"Server Error: {e}", status=500)


def get_people(request):
    people = []
    if not os.path.exists(DATASET_DIR):
        return JsonResponse([], safe=False)

    for name in os.listdir(DATASET_DIR):
        person_dir = os.path.join(DATASET_DIR, name)
        if not os.path.isdir(person_dir):
            continue
        images = [f for f in os.listdir(person_dir) if allowed_file(f)]
        if images:
            avatar_path = f'/static/facedata/{name}/{images[0]}'
            people.append({'id': name, 'name': name, 'avatar': avatar_path})

    return JsonResponse(people, safe=False)


def serve_facedata(request, filename):
    from django.http import FileResponse
    filepath = os.path.join(DATASET_DIR, filename)
    if os.path.exists(filepath):
        return FileResponse(open(filepath, 'rb'))
    return HttpResponse(status=404)


@csrf_exempt
def delete_person(request, name):
    if request.method != 'DELETE':
        return JsonResponse({'success': False, 'error': 'Method not allowed'}, status=405)
    person_dir = os.path.join(DATASET_DIR, secure_filename(name))
    if os.path.exists(person_dir):
        try:
            shutil.rmtree(person_dir)
            return JsonResponse({'success': True})
        except Exception as e:
            return JsonResponse({'success': False, 'error': str(e)}, status=500)
    return JsonResponse({'success': False, 'error': 'Person not found'}, status=404)


def add_people(request):
    name = ''
    existing_count = 0

    if request.method == 'POST':
        name = request.POST.get('name', '').strip()
    else:
        name = request.GET.get('name', '').strip()

    if name:
        person_dir = os.path.join(DATASET_DIR, secure_filename(name))
        if os.path.exists(person_dir):
            existing_count = len([
                f for f in os.listdir(person_dir)
                if os.path.isfile(os.path.join(person_dir, f))
            ])

    if request.method == 'POST':
        files = request.FILES.getlist('photos')
        action = request.POST.get('action')

        if action == 'train':
            if name:
                person_dir = os.path.join(DATASET_DIR, secure_filename(name))
                os.makedirs(person_dir, exist_ok=True)

                saved = 0
                for f in files:
                    if allowed_file(f.name):
                        filepath = os.path.join(person_dir, secure_filename(f.name))
                        with open(filepath, 'wb+') as dest:
                            for chunk in f.chunks():
                                dest.write(chunk)
                        saved += 1

                if saved:
                    messages.success(request, f'Saved {saved} new photo(s) for {name}.')

            try:
                from classifier import retrain_model
                analyzer, _, _, err = _get_ml_components()
                if err:
                    messages.error(request, f'Training failed: {err}')
                else:
                    retrain_model(analyzer)
                    messages.info(request, 'Model training complete.')
            except Exception as e:
                messages.error(request, f'Training error: {e}')

            return redirect('/addpeople' + (f'?name={name}' if name else ''))

        if not name:
            messages.error(request, 'Enter a name')
            return redirect(request.path + f'?name={name}')

        if not files:
            messages.error(request, 'Select at least one photo')
            return redirect(request.path + f'?name={name}')

        person_dir = os.path.join(DATASET_DIR, secure_filename(name))
        os.makedirs(person_dir, exist_ok=True)

        saved = 0
        for f in files:
            if allowed_file(f.name):
                filepath = os.path.join(person_dir, secure_filename(f.name))
                with open(filepath, 'wb+') as dest:
                    for chunk in f.chunks():
                        dest.write(chunk)
                saved += 1

        total_images = existing_count + saved
        messages.success(request, f'Saved {saved} photos. Total: {total_images}')

        return redirect(f'/addpeople?name={name}')

    return render(request, 'addpeople.html', {
        'MIN_IMAGES_REQUIRED': MIN_IMAGES_REQUIRED,
        'existing_count': existing_count,
        'name': name,
    })


def view_incidents(request):
    try:
        all_incidents = get_all_incidents()
        for inc in all_incidents:
            parts = inc['timestamp'].split(' ') if inc['timestamp'] else []
            inc['time_only'] = parts[1] if len(parts) > 1 else ''
        return render(request, 'incidents.html', {'incidents': all_incidents})
    except Exception as e:
        print(f"Error: {e}")
        return HttpResponse("Server Error", status=500)


@csrf_exempt
def add_incident(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    save_incident(
        name=data['name'],
        status=data['status'],
        description=data.get('description', ''),
        timestamp=ts,
    )
    return JsonResponse({
        'success': True,
        'name': data['name'],
        'status': data['status'].capitalize(),
        'description': data.get('description', ''),
        'timestamp': ts,
    })


def _sanitize_embedding(embedding):
    try:
        arr = np.asarray(embedding, dtype=np.float32)
    except Exception:
        return None

    if arr.size == 0:
        return None

    flat = arr.reshape(-1)
    if flat.size < 2 or not np.all(np.isfinite(flat)):
        return None

    return flat


@csrf_exempt
def get_data(request):
    global _trackers, _track_infos

    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    analyzer, classifier, metric, err = _get_ml_components()
    if err:
        print(f"ML components unavailable: {err}")
        return JsonResponse({'error': 'ML components unavailable', 'detail': str(err)}, status=503)

    try:
        data = json.loads(request.body) if request.body else {}
    except json.JSONDecodeError:
        data = {}

    camera_id = data.get('camera_id', 0)

    # Per-camera tracker: each camera gets its own independent Deep SORT tracker
    # so detections from different cameras don't interfere with each other.
    # n_init=1 means tracks confirm on the very first detection hit.
    if camera_id not in _trackers:
        from deep_sort.deep_sort.tracker import Tracker
        _trackers[camera_id] = Tracker(metric, n_init=1)
    if camera_id not in _track_infos:
        _track_infos[camera_id] = {}
    tracker = _trackers[camera_id]
    track_info = _track_infos[camera_id]

    image_b64 = data.get('image', '')

    try:
        if ',' in image_b64:
            image_b64 = image_b64.split(',')[1]
        image_data = base64.b64decode(image_b64)
        import numpy as _np
        import cv2 as _cv2
        arr = _np.frombuffer(image_data, _np.uint8)
        frame = _cv2.imdecode(arr, _cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError('Decoded image is empty')
        # NOTE: Do NOT convert BGR→RGB here. InsightFace's FaceAnalysis.get()
        # expects BGR input (OpenCV's native colour order).
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"Image decode failed: {tb}")
        return JsonResponse({'error': 'Invalid image data', 'detail': str(e)}, status=400)

    faces = analyzer.analyze(frame)

    from deep_sort.deep_sort.detection import Detection
    detections = []
    for i, face in enumerate(faces):
        try:
            bbox = getattr(face, 'bbox', None)
            embedding = getattr(face, 'embedding', None)
            if bbox is None or len(bbox) != 4:
                continue

            emb = _sanitize_embedding(embedding)
            if emb is None:
                continue

            x1, y1, x2, y2 = [float(v) for v in bbox]
            w, h = max(0.0, x2 - x1), max(0.0, y2 - y1)
            if w <= 0 or h <= 0:
                continue

            detections.append(Detection([x1, y1, w, h], 1.0, emb))
        except Exception as exc:
            print(f"Skipping malformed detection: {exc}")
            continue

    if not detections:
        return JsonResponse([], safe=False)

    tracker.predict()
    tracker.update(detections)

    results = []
    active_tracks = set()

    from config import STATUS_COLORS
    from utils import rgb_to_hex
    for track in tracker.tracks:
        if not track.is_confirmed() or track.time_since_update > 0:
            continue

        track_id = track.track_id
        active_tracks.add(track_id)

        if track_id not in track_info:
            track_info[track_id] = {
                'recognized_count': 0,
                'unrecognized_count': 0,
                'label': None,
                'confidence': 0.0,
                'last_feature': None,
                'status': 'unknown',
                'last_updated': datetime.now(),
            }

        info = track_info[track_id]
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        current_feature = None

        for detection in detections:
            track_bbox = track.to_tlbr()
            det_bbox = detection.to_tlbr()
            iou = bb_intersection_over_union(track_bbox, det_bbox)
            if iou > 0.5:
                current_feature = detection.feature
                info['last_feature'] = current_feature
                break

        if current_feature is None and info['last_feature'] is not None:
            current_feature = info['last_feature']

        if current_feature is not None and info['recognized_count'] < MIN_RECOGNITION_COUNT:
            status, label, conf = classifier.classify(current_feature)
            if status == 'recognized' and conf > MIN_CONFIDENCE:
                info['recognized_count'] += 1
                info['unrecognized_count'] = 0
                info['label'] = label
                info['confidence'] = conf
                info['status'] = 'recognized'
                save_face_record(label, conf, track.to_tlbr().tolist(), current_feature, timestamp)
            else:
                info['unrecognized_count'] += 1
                info['status'] = 'unknown'
                if info['unrecognized_count'] >= MIN_RECOGNITION_COUNT:
                    info['status'] = 'unknown_permanent'
        elif info['recognized_count'] >= MIN_RECOGNITION_COUNT:
            status = 'recognized'
            label = info['label']
            conf = info['confidence']
            info['status'] = 'recognized_permanent'
        else:
            status = info['status']
            label = info['label']
            conf = info['confidence']

        results.append({
            'bbox': track.to_tlbr().tolist(),
            'status': status,
            'label': label,
            'confidence': conf,
            'timestamp': timestamp,
            'color': rgb_to_hex(STATUS_COLORS.get(status, (255, 255, 0))),
            'track_id': track_id,
        })

    for track_id in list(track_info.keys()):
        if track_id not in active_tracks:
            if track_info[track_id].get('status') not in ['recognized_permanent', 'recognized']:
                del track_info[track_id]

    # track_info is already a reference to _track_infos[camera_id],
    # so in-place mutations above are persisted automatically.
    return JsonResponse(results, safe=False)
