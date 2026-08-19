# config.py
import os

# Model paths
MODEL_DIR = "./Models"
DETECTION_MODEL_PATH = os.path.join(MODEL_DIR, "scrfd_10g_bnkps.onnx")
RECOGNITION_MODEL_PATH = os.path.join(MODEL_DIR, "glintr100.onnx")
CLASSIFIER_DIR = "./Models"

# ML Model Artifact Paths
ISOLATION_FOREST_PATH = os.path.join(MODEL_DIR, "isolation_forest.pkl")
SVM_MODEL_PATH = os.path.join(MODEL_DIR, "svm_model.pkl")  # Updated filename
LABEL_ENCODER_PATH = os.path.join(MODEL_DIR, "label_encoder.pkl")
FEATURIZER_PATH = os.path.join(MODEL_DIR, "centroid_featurizer.pkl")  # Feature engineering pipeline
PCA_MODEL_PATH = os.path.join(MODEL_DIR, "pca.pkl")

# Confidence threshold
CONFIDENCE_THRESHOLD = 0.6

# Status colors (BGR format for OpenCV)
STATUS_COLORS = {
    "recognized": (52, 201, 36),   # Green
    "unknown": (220, 53, 69),      # Red
    "processing": (255, 193, 7)    # Yellow
}

# Database configuration
DB_CONFIG = {
    'server': 'localhost',
    'database': 'FaceRecognitionDB',
    'username': 'sa',
    'password': 'YourStrongPassword123'
}

class Config:
    SECRET_KEY = os.getenv('FLASK_SECRET', 'a-very-secret-key')

    # Flask-Mail (using Gmail SMTP)
    MAIL_SERVER = 'smtp.gmail.com'
    MAIL_PORT = 587
    MAIL_USE_TLS = True
    MAIL_USERNAME = os.getenv('MAIL_USERNAME', 'admin@gmail.com')
    MAIL_PASSWORD = os.getenv('MAIL_PASSWORD', 'admin123')