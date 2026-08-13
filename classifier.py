# classifier.py
import os
import pickle
import logging
import numpy as np
import cv2

from sklearn.ensemble import IsolationForest
from sklearn.svm import SVC
from sklearn.preprocessing import LabelEncoder, normalize
from sklearn.utils import shuffle
from tqdm import tqdm

from config import (
    ISOLATION_FOREST_PATH,
    SVM_MODEL_PATH,
    LABEL_ENCODER_PATH,
    FEATURIZER_PATH,
    CONFIDENCE_THRESHOLD,
)

logger = logging.getLogger(__name__)


class CentroidFeaturizer:
    """Embedding-space Feature Engineering:
    Computes class centroid vectors and transforms input face embeddings into a hybrid
    feature representation combining raw L2-normalized features with explicit Cosine
    Similarity scores against every enrolled identity's template vector.
    """

    def __init__(self):
        self.centroids = None

    def fit(self, X: np.ndarray, y: np.ndarray):
        unique_labels = np.unique(y)
        centroids_list = []
        for label in unique_labels:
            class_embs = X[y == label]
            mean_vec = np.mean(class_embs, axis=0, keepdims=True)
            norm_mean = normalize(mean_vec, norm="l2", axis=1)[0]
            centroids_list.append(norm_mean)
        self.centroids = np.array(centroids_list, dtype=np.float32)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        if self.centroids is None or len(self.centroids) == 0:
            return X
        # Cosine similarity against each class centroid (dot product on L2-normalized vectors)
        similarities = np.dot(X, self.centroids.T)
        # Feature Fusion: Concatenate raw L2 embedding with identity similarity features
        return np.hstack([X, similarities])

    def fit_transform(self, X: np.ndarray, y: np.ndarray) -> np.ndarray:
        self.fit(X, y)
        return self.transform(X)


def _load_pickle(path: str, label: str):
    """Safely load a pickled object from disk."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing {label} model: {path}")
    if os.path.getsize(path) == 0:
        raise ValueError(f"{label} model file is empty: {path}")

    with open(path, "rb") as f:
        return pickle.load(f)


def _save_pickle(path: str, obj, label: str):
    """Safely save a pickled object to disk."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        pickle.dump(obj, f)
    logger.info(f"Saved {label} to '{path}'")


def preprocess_embedding(embedding: np.ndarray) -> np.ndarray:
    """Ensures 2D matrix shape and projects embedding onto the unit hypersphere via L2 normalization."""
    arr = np.array(embedding, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    return normalize(arr, norm="l2", axis=1)


def extract_robust_embedding(analyzer, rgb_image: np.ndarray) -> np.ndarray | None:
    """Extracts a Test-Time Augmented (TTA) embedding using horizontal flip averaging
    to cancel out head-pose and lighting noise.
    """
    faces_orig = analyzer.analyze(rgb_image)
    if not faces_orig:
        return None

    emb_orig = faces_orig[0].embedding

    # Horizontal flip for pose-symmetry averaging
    flipped_rgb = cv2.flip(rgb_image, 1)
    faces_flip = analyzer.analyze(flipped_rgb)

    if faces_flip:
        emb_flip = faces_flip[0].embedding
        combined = (np.array(emb_orig) + np.array(emb_flip)) / 2.0
    else:
        combined = np.array(emb_orig)

    return preprocess_embedding(combined)[0]


class FaceClassifier:
    def __init__(self):
        logger.info("Loading classifier models and feature pipelines...")
        try:
            self.iso_forest = _load_pickle(ISOLATION_FOREST_PATH, "Isolation Forest")
            self.model = _load_pickle(SVM_MODEL_PATH, "SVM Classifier")
            self.le = _load_pickle(LABEL_ENCODER_PATH, "Label Encoder")
            self.featurizer = _load_pickle(FEATURIZER_PATH, "Centroid Featurizer")
        except Exception as exc:
            raise ValueError(
                f"Classifier model files are missing or corrupt. Retrain the model before using recognition. Details: {exc}"
            ) from exc
        logger.info("Classifier models and feature pipelines successfully loaded.")

    def classify(self, embedding: np.ndarray):
        """Classifies a face embedding using the engineered feature pipeline."""
        norm_emb = preprocess_embedding(embedding)

        # Preserve a low-risk fallback: do not reject valid embeddings immediately
        # just because the isolation forest is conservative with a small dataset.
        is_outlier = self.iso_forest.predict(norm_emb)[0]

        X_feat = self.featurizer.transform(norm_emb)
        probs = self.model.predict_proba(X_feat)[0]
        max_idx = np.argmax(probs)
        confidence = float(probs[max_idx])

        if confidence >= CONFIDENCE_THRESHOLD:
            label = self.le.inverse_transform([max_idx])[0]
            return "recognized", label, confidence

        if is_outlier == -1 and confidence < CONFIDENCE_THRESHOLD:
            return "unknown", "Unknown", confidence

        return "processing", "Process...", confidence


def retrain_model(analyzer, image_path: str = "./facedata"):
    """Extracts embeddings with TTA, transforms feature vectors, trains models, and saves artifacts directly to config paths."""
    embeddings, labels = [], []

    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Dataset path '{image_path}' does not exist.")

    # 1. Extract face embeddings using Test-Time Augmentation (Flip Averaging)
    for person in tqdm(os.listdir(image_path), desc="Persons", unit="person"):
        person_dir = os.path.join(image_path, person)
        if not os.path.isdir(person_dir):
            continue

        for img_name in tqdm(
            os.listdir(person_dir), desc=f"Images ({person})", unit="img", leave=False
        ):
            img_path = os.path.join(person_dir, img_name)
            bgr = cv2.imread(img_path)
            if bgr is None:
                continue

            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            emb = extract_robust_embedding(analyzer, rgb)
            if emb is None:
                continue

            embeddings.append(emb)
            labels.append(person)

    if not embeddings:
        raise ValueError("No face embeddings were found in the dataset. Add valid face photos first.")

    # 2. Base Matrix Preparation & L2 Normalization
    X_raw = np.array(embeddings, dtype=np.float32)
    X_raw = normalize(X_raw, norm="l2", axis=1)
    y = np.array(labels)

    # Shuffle dataset consistently
    X_raw, y = shuffle(X_raw, y, random_state=42)

    # 3. Outlier Detector (Isolation Forest trained on raw L2 vectors)
    iso_forest_model = IsolationForest(contamination=0.03, random_state=42)
    iso_forest_model.fit(X_raw)

    # 4. Label Encoding
    le = LabelEncoder()
    y_encoded = le.fit_transform(y)

    # 5. Embedding Feature Engineering (Centroid Cosine Similarity Fusion)
    featurizer = CentroidFeaturizer()
    X_enhanced = featurizer.fit_transform(X_raw, y_encoded)

    # 6. Classifier Training (Linear SVM on Enhanced Feature Space)
    model = SVC(kernel="linear", probability=True, C=1.0, random_state=42)
    model.fit(X_enhanced, y_encoded)

    # 7. Persist Artifacts using configured paths directly
    _save_pickle(ISOLATION_FOREST_PATH, iso_forest_model, "Isolation Forest")
    _save_pickle(SVM_MODEL_PATH, model, "SVM Classifier")
    _save_pickle(LABEL_ENCODER_PATH, le, "Label Encoder")
    _save_pickle(FEATURIZER_PATH, featurizer, "Centroid Featurizer")

    logger.info("Retraining complete. All model artifacts saved successfully.")