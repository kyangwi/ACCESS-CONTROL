
# face_analyzer.p
import os
from insightface.app import FaceAnalysis
import onnxruntime as ort
from insightface.model_zoo import model_zoo
from config import DETECTION_MODEL_PATH, RECOGNITION_MODEL_PATH
from utils import rgb_to_hex
import logging

logger = logging.getLogger(__name__)

class FaceAnalyzer:
    def __init__(self):
        # Force CPU mode here because CUDA provider DLLs fail to load in this environment.
        # This keeps the app stable and guarantees that model inference can proceed.
        try:
            self.app = FaceAnalysis(name='buffalo_l')
            self._prepare()
        except Exception as e:
            logger.error(f"FaceAnalysis initialization failed: {e}")
            raise

    def _load_models(self):
        """Load InsightFace detection and recognition models"""
        logger.info("Loading InsightFace models...")

        # This method is kept for compatibility but we prefer FaceAnalysis
        # to manage model loading. If more advanced custom model wiring is
        # required, implement it here.
        return

        self.app.det_model = det_model
        self.app.rec_model = rec_model
        self.app.models = {'detection': det_model, 'recognition': rec_model}

    def _prepare(self):
        """Prepare the model for inference using GPU if available, otherwise fallback to CPU."""
        try:
            providers = ort.get_available_providers()
            logger.info(f"ONNX Runtime providers: {providers}")

            if 'CUDAExecutionProvider' in providers:
                logger.info("CUDAExecutionProvider is available; initializing InsightFace on GPU (device 0)")
                ctx_id = 0
            else:
                logger.info("CUDAExecutionProvider is not available; falling back to CPU mode")
                ctx_id = -1

            self.app.prepare(ctx_id=ctx_id, det_size=(640, 640))

            det_session = getattr(getattr(self.app, 'det_model', None), 'session', None)
            rec_session = getattr(getattr(self.app, 'rec_model', None), 'session', None)
            if det_session is None or rec_session is None:
                logger.warning("InsightFace detection/recognition session was not initialized; continuing with CPU fallback if available")

            logger.info(f"Face analyzer ready (running on {'GPU' if ctx_id == 0 else 'CPU'}).")
        except Exception as e:
            logger.error(f"FaceAnalysis.prepare failed: {e}")
            raise

    def analyze(self, frame):
        """Run full analysis on input frame."""
        if self.app is None:
            logger.warning("FaceAnalyzer app is not initialized.")
            return []

        try:
            return self.app.get(frame)
        except Exception as exc:
            logger.exception(f"Face analysis failed: {exc}")
            return []