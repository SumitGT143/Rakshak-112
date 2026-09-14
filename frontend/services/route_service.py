"""
Route Service for Rakshak 112 Dynamic Dispatch Engine.
Provides Haversine distance, traffic congestion modeling, and ETA calculations
with modular abstraction for production routing providers (e.g. OSRM / Google Maps / Mapbox).
"""

import math
from typing import Dict, Any, Tuple, Optional

# Average urban emergency speeds (km/h) under normal conditions
DEFAULT_URBAN_SPEED_KMH = 42.0
DEFAULT_GREEN_CORRIDOR_SPEED_KMH = 58.0
TRAFFIC_CONGESTION_LEVELS = {
    "clear": 1.0,
    "moderate": 1.25,
    "heavy": 1.75,
    "gridlock": 2.6
}

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points in kilometers."""
    if lat1 is None or lon1 is None or lat2 is None or lon2 is None:
        return 5.0
    r = 6371.0  # Earth's radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2.0) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r * c

class RouteService:
    def __init__(self, routing_provider: Optional[Any] = None):
        self.routing_provider = routing_provider
        # In-memory traffic congestion override map (e.g. "lat,lon" -> factor)
        self.traffic_overrides: Dict[str, float] = {}

    def set_traffic_override(self, corridor_id: str, congestion_multiplier: float):
        self.traffic_overrides[corridor_id] = congestion_multiplier

    def get_travel_eta(
        self,
        origin: Tuple[float, float],
        destination: Tuple[float, float],
        is_green_corridor: bool = False,
        traffic_level: str = "moderate",
        custom_traffic_factor: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Calculate travel distance and validated ETA (in minutes).
        origin: (lat, lon)
        destination: (lat, lon)
        """
        lat1, lon1 = origin
        lat2, lon2 = destination
        
        # 1. Base distance (km) with 1.22 urban winding road factor
        crow_dist = haversine_distance(lat1, lon1, lat2, lon2)
        road_distance_km = round(max(0.4, crow_dist * 1.22), 2)
        
        # 2. Base speed
        base_speed = DEFAULT_GREEN_CORRIDOR_SPEED_KMH if is_green_corridor else DEFAULT_URBAN_SPEED_KMH
        
        # 3. Traffic multiplier
        traffic_factor = custom_traffic_factor or TRAFFIC_CONGESTION_LEVELS.get(traffic_level.lower(), 1.25)
        if is_green_corridor:
            traffic_factor = max(0.85, traffic_factor * 0.65)  # green wave reduces signal wait
        
        # 4. Calculate ETA (minutes)
        effective_speed = max(15.0, base_speed / traffic_factor)
        travel_hours = road_distance_km / effective_speed
        eta_minutes = max(1.5, round(travel_hours * 60.0 + (0.8 if not is_green_corridor else 0.3), 1))
        
        return {
            "distance_km": road_distance_km,
            "eta_minutes": eta_minutes,
            "eta_seconds": int(eta_minutes * 60),
            "traffic_factor": traffic_factor,
            "is_green_corridor": is_green_corridor
        }

# Global singleton
route_service = RouteService()
