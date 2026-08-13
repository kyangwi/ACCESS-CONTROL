# train_classifier.py
import os
import time
import logging
from face_analyzer import FaceAnalyzer
from classifier import retrain_model

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger(__name__)


def main():
    dataset_path = "./facedata"

    # 1. Pre-flight Dataset Check
    if not os.path.exists(dataset_path):
        logger.error(f"Dataset directory '{os.path.abspath(dataset_path)}' does not exist!")
        return

    # Filter out non-directory files (e.g., .DS_Store or stray files)
    identities = [
        d for d in os.listdir(dataset_path)
        if os.path.isdir(os.path.join(dataset_path, d))
    ]

    if not identities:
        logger.error(
            f"No person folders found in '{dataset_path}'. "
            "Ensure images are nested inside subfolders (e.g., ./facedata/Gringo/img1.jpg)."
        )
        return

    logger.info(f"Found {len(identities)} identities to process: {identities}")

    # 2. Initialize Face Analyzer (InsightFace on CPU)
    logger.info("Initializing FaceAnalyzer...")
    start_time = time.time()

    try:
        analyzer = FaceAnalyzer()
    except Exception as exc:
        logger.critical(f"Failed to initialize FaceAnalyzer: {exc}")
        return

    # 3. Retrain Pipeline Execution
    logger.info("Extracting embeddings with TTA flip-averaging and training classifier...")
    try:
        retrain_model(analyzer, image_path=dataset_path)
        elapsed = time.time() - start_time
        logger.info(f"Retraining complete in {elapsed:.2f}s!")
        logger.info("All model artifacts saved to the configured Models directory.")
    except Exception as exc:
        logger.error(f"Retraining failed: {exc}", exc_info=True)


if __name__ == "__main__":
    main()