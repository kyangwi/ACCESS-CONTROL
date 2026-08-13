from django.urls import path
from . import views

urlpatterns = [
    path('', views.home, name='home'),
    path('records', views.records_page, name='records'),
    path('addpeople', views.add_people, name='add_people'),
    path('incidents', views.view_incidents, name='view_incidents'),
    path('incidents/add', views.add_incident, name='add_incident'),
    path('getdata/', views.get_data, name='get_data'),
    path('api/people', views.get_people, name='get_people'),
    path('api/people/<str:name>', views.delete_person, name='delete_person'),
    path('static/facedata/<path:filename>', views.serve_facedata, name='serve_facedata'),
]
