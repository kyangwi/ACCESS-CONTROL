from django.urls import path
from . import views

urlpatterns = [
    path('', views.home, name='home'),
    path('records', views.records_page, name='records'),
    path('addpeople', views.add_people, name='add_people'),
    path('incidents', views.view_incidents, name='view_incidents'),
    path('incidents/add', views.add_incident, name='add_incident'),
    path('search', views.search_page, name='search'),
    path('calendar', views.calendar_page, name='calendar'),
    path('api/calendar-details', views.calendar_details_api, name='calendar_details_api'),
    path('getdata/', views.get_data, name='get_data'),
    path('api/people', views.get_people, name='get_people'),
    path('api/people/<str:name>', views.delete_person, name='delete_person'),
    path('facedata/<path:filename>', views.serve_facedata, name='serve_facedata'),
]
