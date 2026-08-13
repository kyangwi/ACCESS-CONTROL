import builtins
import sys
import types
from unittest.mock import patch

import numpy as np
from django.test import TestCase

from core import views


class MLComponentFallbackTests(TestCase):
    def test_get_ml_components_uses_dummy_classifier_when_classifier_import_fails(self):
        views._analyzer = None
        views._classifier = None
        views._metric = None

        original_import = builtins.__import__

        def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == 'classifier':
                raise ImportError('simulated missing classifier module')
            return original_import(name, globals, locals, fromlist, level)

        face_module = types.ModuleType('face_analyzer')

        class DummyFaceAnalyzer:
            def __init__(self):
                pass

        face_module.FaceAnalyzer = DummyFaceAnalyzer

        metric_package = types.ModuleType('deep_sort.deep_sort')
        metric_module = types.ModuleType('deep_sort.deep_sort.nn_matching')

        class DummyMetric:
            def __init__(self, *args, **kwargs):
                pass

        metric_module.NearestNeighborDistanceMetric = DummyMetric
        metric_package.nn_matching = metric_module

        with patch.dict(sys.modules, {
            'face_analyzer': face_module,
            'deep_sort': types.ModuleType('deep_sort'),
            'deep_sort.deep_sort': metric_package,
            'deep_sort.deep_sort.nn_matching': metric_module,
        }), patch('builtins.__import__', side_effect=fake_import):
            analyzer, classifier, metric, err = views._get_ml_components()

        self.assertIsNotNone(analyzer)
        self.assertIsNotNone(classifier)
        self.assertIsNotNone(metric)
        self.assertIsNone(err)

    def test_retrain_model_uses_cpu_fallback_when_gpu_not_available(self):
        captured = {}

        class DummyAnalyzer:
            def analyze(self, rgb):
                return [types.SimpleNamespace(embedding=np.array([0.1, 0.2, 0.3], dtype=float))]

        class DummyForest:
            def fit(self, embeddings):
                return embeddings

        class DummyCatBoost:
            def __init__(self, **kwargs):
                captured['kwargs'] = kwargs

            def fit(self, embeddings, labels):
                return None

        with patch('classifier.os.listdir', return_value=['alice']), \
             patch('classifier.os.path.isdir', return_value=True), \
             patch('classifier.os.makedirs'), \
             patch('classifier.tqdm', lambda iterable, **kwargs: iterable), \
             patch('classifier.cv2.imread', return_value=np.zeros((10, 10, 3), dtype=np.uint8)), \
             patch('classifier.cv2.cvtColor', return_value=np.zeros((10, 10, 3), dtype=np.uint8)), \
             patch('classifier.IsolationForest', return_value=DummyForest()), \
             patch('classifier.CatBoostClassifier', side_effect=DummyCatBoost), \
             patch('classifier.pickle.dump'), \
             patch('classifier.LabelEncoder') as label_encoder_cls:
            label_encoder_cls.return_value.fit_transform.return_value = np.array([0])
            from classifier import retrain_model
            retrain_model(DummyAnalyzer())

        self.assertEqual(captured['kwargs'].get('task_type'), 'CPU')
