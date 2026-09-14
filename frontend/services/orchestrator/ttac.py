"""
Time To Appropriate Care (TTAC) Calculation Engine for Rakshak 112.
Calculates TTAC = Response ETA + Scene Delay + Transport ETA + Hospital Handover Delay.
Exposes full component breakdown for explainability and Control Room visualization.
"""

from typing import Dict, Any
from .config import DEFAULT_SCENE_DELAY_MINUTES, DEFAULT_HANDOVER_DELAY_MINUTES

def calculate_ttac(
    response_eta_minutes: float,
    transport_eta_minutes: float,
    scene_delay_minutes: float = DEFAULT_SCENE_DELAY_MINUTES,
    handover_delay_minutes: float = DEFAULT_HANDOVER_DELAY_MINUTES,
    is_critical: bool = False
) -> Dict[str, Any]:
    """
    Computes total Time To Appropriate Care and full component breakdown.
    """
    resp_eta = max(0.5, float(response_eta_minutes))
    trans_eta = max(0.5, float(transport_eta_minutes))
    scene_del = max(0.5, float(scene_delay_minutes))
    hand_del = max(0.5, float(handover_delay_minutes))
    
    total_ttac = round(resp_eta + scene_del + trans_eta + hand_del, 1)
    
    return {
        "ttacMinutes": total_ttac,
        "breakdown": {
            "responseEtaMinutes": resp_eta,
            "sceneDelayMinutes": scene_del,
            "transportEtaMinutes": trans_eta,
            "handoverDelayMinutes": hand_del
        },
        "displaySummary": f"{resp_eta}m (response) + {scene_del}m (scene) + {trans_eta}m (transit) + {hand_del}m (handover) = {total_ttac}m TTAC"
    }
