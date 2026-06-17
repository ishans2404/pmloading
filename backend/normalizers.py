import re
from datetime import datetime
from fastapi_memory import fm_lru
from typing import Optional

PLATE_TYPE_ORDER = {"OK": 0, "RA": 1, "TPI": 2, "MTI": 3, "DIV": 4, "ZCMO": 5}


@fm_lru(maxsize=1024)
def parse_consignee_info(raw: str = "") -> dict:
    m = re.match(r"^(.*?)\s*Consignee Code:\s*(\S+)", raw, re.IGNORECASE)
    if m:
        return {"name": m.group(1).strip(), "code": m.group(2).strip()}
    return {"name": raw.strip(), "code": raw.strip()}


def infer_type_from_context(context_before: str, field_default: str) -> str:
    upper = (context_before or "").upper()
    labels = [
        {"type": "OK", "pattern": "OK PLATES"},
        {"type": "RA", "pattern": "RA PLATES"},
        {"type": "TPI", "pattern": "TPI PLATES"},
        {"type": "MTI", "pattern": "MTI PENDING"},
        {"type": "DIV", "pattern": "DIV"},
    ]
    best = {"type": field_default, "idx": -1}
    for item in labels:
        idx = upper.rfind(item["pattern"])
        if idx > best["idx"]:
            best = {"type": item["type"], "idx": idx}
    return best["type"]


def expand_plates(parts: list) -> list:
    if not parts:
        return []
    first_base = parts[0].split("/")[0]
    prefix = first_base[:-3]
    result = []
    for idx, part in enumerate(parts):
        if idx == 0:
            result.append(part)
            continue
        slash_idx = part.find("/")
        if slash_idx >= 0:
            digits = part[:slash_idx]
            suffix = part[slash_idx:]
        else:
            digits = part
            suffix = ""
        result.append(prefix + digits + suffix)
    return result


def parse_field_plates(field_str: Optional[str], field_name: str) -> list:
    if not field_str or not isinstance(field_str, str):
        return []
    s = field_str.strip()
    if not s:
        return []

    field_defaults = {
        "HEAT": "OK",
        "PLATES": "RA",
        "TPI_PLATES": "TPI",
        "MTI_PENDING_PLATES": "MTI",
        "DIV": "DIV",
        "ZCMO_PLATES": "ZCMO",
    }
    field_default = field_defaults.get(field_name, "OK")
    out = []

    ok_re = re.compile(r"([A-Z]\d+)#OK-([\d/,\s]+)")
    for m in ok_re.finditer(s):
        heat_no = m.group(1)
        parts = [p.strip() for p in m.group(2).split(",") if re.match(r"^\d", p.strip())]
        if not parts:
            continue
        if len(parts[0].split("/")[0]) < 7:
            continue
        for plate_no in expand_plates(parts):
            out.append({"plateNo": plate_no, "heatNo": heat_no, "plateType": "OK"})

    non_ok_re = re.compile(r"([A-Z]\d{5,6})-(\d[\d/,\s]*)")
    for m in non_ok_re.finditer(s):
        if m.start() > 0 and s[m.start() - 1] == "#":
            continue
        heat_no = m.group(1)
        parts = [p.strip() for p in m.group(2).split(",") if re.match(r"^\d", p.strip())]
        if not parts:
            continue
        if len(parts[0].split("/")[0]) < 7:
            continue
        plate_type = infer_type_from_context(s[: m.start()], field_default)
        for plate_no in expand_plates(parts):
            out.append({"plateNo": plate_no, "heatNo": heat_no, "plateType": plate_type})

    tpi_re = re.compile(r"([A-Z]\d{5,6})#-(\d[\d/,\s]*)")
    for m in tpi_re.finditer(s):
        heat_no = m.group(1)
        parts = [p.strip() for p in m.group(2).split(",") if re.match(r"^\d", p.strip())]
        if not parts:
            continue
        if len(parts[0].split("/")[0]) < 7:
            continue
        plate_type = infer_type_from_context(s[: m.start()], field_default)
        for plate_no in expand_plates(parts):
            out.append({"plateNo": plate_no, "heatNo": heat_no, "plateType": plate_type})

    # ZCMO plates use #OK- format so ok_re parses them as "OK"; override here.
    if field_name == "ZCMO_PLATES":
        for item in out:
            item["plateType"] = "ZCMO"

    return out


@fm_lru(maxsize=1024)
def parse_size(ord_size: str = "") -> dict:
    parts = [p.strip() for p in str(ord_size or "").strip().split("x")]
    return {
        "thickness": parts[0] if len(parts) > 0 else "",
        "width": parts[1] if len(parts) > 1 else "",
        "length": parts[2] if len(parts) > 2 else "",
    }


def normalize_loading_data(raw: list, dest_code: str = "") -> list:
    if not isinstance(raw, list):
        return []

    consignee_map: dict = {}

    for row in raw:
        info = parse_consignee_info(row.get("CONSIGNEE_NM", ""))
        code = info["code"]
        name = info["name"]
        if not code:
            continue

        if code not in consignee_map:
            consignee_map[code] = {
                "consigneeCode": code,
                "consigneeName": name,
                "wagonNo": None,
                "plates": [],
                "orders": [],
            }

        c = consignee_map[code]
        size_info = parse_size(row.get("ORD_SIZE", ""))

        remark_raw = row.get("REMART") or ""
        remark = re.sub(r"^/|/$", "", remark_raw).strip()

        order = {
            "ordNo": row.get("ORD_NO", ""),
            "grade": row.get("GRADE", ""),
            "tdc": (row.get("TDC") or "").strip(),
            "colourCd": row.get("COLOUR_CD", ""),
            "ordSize": row.get("ORD_SIZE", ""),
            "thickness": size_info["thickness"],
            "width": size_info["width"],
            "length": size_info["length"],
            "pcWgt": row.get("PC_WGT"),
            "ordType": row.get("ORD_TYPE", ""),
            "usageGrp": row.get("USAGE_GRP", ""),
            "destNm": row.get("DEST_NM", ""),
            "dispatchMode": row.get("DISPATCH_MODE", ""),
            "ordThk": row.get("ORD_THK"),
            "ord": row.get("ORD", 0),
            "desp": row.get("DESP", 0),
            "bal": row.get("BAL", 0),
            "bfr": row.get("BFR", 0),
            "bfr1": row.get("BFR1"),
            "fin": row.get("FIN", 0),
            "finstk": row.get("FINSTK", 0),
            "norm": row.get("NORM", 0),
            "test": row.get("TEST", 0),
            "ra": row.get("RA", 0),
            "tpi": row.get("TPI", 0),
            "nop": row.get("NOP", ""),
            "wgt": row.get("WGT", ""),
            "pmBfd": row.get("PM_BFD", 0),
            "remark": remark,
            "ordPr": (row.get("ORD_PR") or "").strip(),
            "nor": row.get("NOR", ""),
            "heatRaw": (row.get("HEAT") or "").strip(),
            "platesRaw": (row.get("PLATES") or "").strip(),
            "tpiPlatesRaw": (row.get("TPI_PLATES") or "").strip(),
            "mtiPendingRaw": (row.get("MTI_PENDING_PLATES") or "").strip(),
            "divRaw": (row.get("DIV") or "").strip(),
            "zcmoPlatesRaw": (row.get("ZCMO_PLATES") or "").strip(),
        }
        c["orders"].append(order)

        for field_name, field_value in [
            ("HEAT", row.get("HEAT")),
            ("PLATES", row.get("PLATES")),
            ("TPI_PLATES", row.get("TPI_PLATES")),
            ("MTI_PENDING_PLATES", row.get("MTI_PENDING_PLATES")),
            ("DIV", row.get("DIV")),
            ("ZCMO_PLATES", row.get("ZCMO_PLATES")),
        ]:
            for plate in parse_field_plates(field_value, field_name):
                c["plates"].append(
                    {
                        "plateNo": plate["plateNo"],
                        "heatNo": plate["heatNo"],
                        "plateType": plate["plateType"],
                        "ordNo": order["ordNo"],
                        "grade": order["grade"],
                        "tdc": order["tdc"],
                        "colourCd": order["colourCd"],
                        "ordSize": order["ordSize"],
                        "thickness": order["thickness"],
                        "width": order["width"],
                        "length": order["length"],
                        "pcWgt": order["pcWgt"],
                        "loaded": False,
                        "loadedAt": None,
                    }
                )

    result = []
    for c in consignee_map.values():
        by_physical: dict = {}
        for p in c["plates"]:
            key = p["plateNo"][3:] if p["plateNo"].startswith("OK-") else p["plateNo"]
            if key not in by_physical:
                by_physical[key] = p
            else:
                existing = by_physical[key]
                old_rank = PLATE_TYPE_ORDER.get(existing["plateType"], 99)
                new_rank = PLATE_TYPE_ORDER.get(p["plateType"], 99)
                if new_rank < old_rank:
                    by_physical[key] = p

        c["plates"] = sorted(
            by_physical.values(),
            key=lambda p: (PLATE_TYPE_ORDER.get(p["plateType"], 99), p["plateNo"]),
        )
        c["okPlateCount"] = sum(1 for p in c["plates"] if p["plateType"] == "OK")
        c["totalPlateCount"] = len(c["plates"])
        result.append(c)

    result.sort(key=lambda c: (-c["okPlateCount"], c["consigneeName"]))
    return result


def normalize_destinations(raw) -> list:
    if isinstance(raw, list):
        arr = raw
    elif isinstance(raw, dict):
        arr = raw.get("data") or raw.get("destinations") or list(raw.values())
    else:
        arr = []

    result = []
    for d in arr:
        if isinstance(d, dict):
            code = (
                d.get("dest_cd") or d.get("code") or d.get("DEST_CD") or d.get("Code") or str(d)
            )
            name = (
                d.get("dest_nm") or d.get("name") or d.get("DEST_NM") or d.get("Name") or str(d)
            )
        else:
            code = str(d)
            name = str(d)

        if isinstance(name, str) and "/" in name:
            name = name.split("/")[-1].strip()

        if code and name:
            result.append({"code": str(code), "name": str(name)})

    return result


def normalize_rake_status(raw: str) -> str:
    s = str(raw or "").upper().strip()
    if s in ["IN_PROGRESS", "INPROGRESS", "IN PROGRESS", "P", "LOADING"]:
        return "IN_PROGRESS"
    if s in ["COMPLETED", "COMPLETE", "DONE", "C", "CLOSED"]:
        return "COMPLETED"
    return "ACTIVE"


def clean_rake_dest_name(name: str, code: str) -> str:
    if not name:
        return code or ""
    cleaned = name.split("/")[-1].strip() if "/" in name else name.strip()
    result = re.sub(
        rf"\s*[/(]{re.escape(code)}[/)]?\s*$", "", cleaned, flags=re.IGNORECASE
    ).strip()
    return result or cleaned


def _parse_created_at(val) -> float:
    if not val:
        return 0.0
    try:
        return datetime.fromisoformat(str(val).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def normalize_rakes_list(raw) -> list:
    if isinstance(raw, list):
        arr = raw
    elif isinstance(raw, dict):
        arr = raw.get("data") or list(raw.values())
    else:
        arr = []

    rake_map: dict = {}

    for row in arr:
        if not isinstance(row, dict):
            continue
        rake_id = str(
            row.get("RAKEID_INT")
            or row.get("RakeId")
            or row.get("RAKE_ID")
            or row.get("rakeid")
            or row.get("RAKEID")
            or ""
        ).strip()
        if not rake_id:
            continue

        if rake_id not in rake_map:
            rake_map[rake_id] = {
                "rakeId": rake_id,
                "destinations": [],
                "status": normalize_rake_status(
                    row.get("STATUS") or row.get("RAKE_STATUS") or row.get("LOAD_STATUS") or ""
                ),
                "totalWagons": row.get("TOTAL_WAGONS") or row.get("TOT_WAGONS") or row.get("NO_OF_WAGONS"),
                "createdAt": row.get("CREATED_TM") or row.get("CREATED_DT") or row.get("RAKE_DT") or row.get("CREATE_DT"),
                "createdBy": str(
                    row.get("CREATED_ID") or row.get("CREATED_BY") or row.get("USER_ID") or row.get("USERID") or ""
                ).strip(),
                "completedAt": row.get("COMPLETED_DT") or row.get("COMP_DT"),
                "loadedPlates": row.get("LOADED_PLATES") or row.get("LOAD_PLATES"),
                "totalPlates": row.get("TOTAL_PLATES") or row.get("TOT_PLATES"),
                "tramsId": row.get("RAKEID_TRAMS") or row.get("TRAMS_ID") or "",
            }

        rake = rake_map[rake_id]

        # Update tramsId if a later row provides it
        trams = str(row.get("RAKEID_TRAMS") or row.get("TRAMS_ID") or "").strip()
        if trams and not rake.get("tramsId"):
            rake["tramsId"] = trams

        pairs = [
            (
                str(row.get("DEST_CD1") or row.get("DEST_CD") or row.get("dest_cd1") or row.get("dest_cd") or ""),
                str(row.get("DEST_NM1") or row.get("DEST_NM") or row.get("dest_nm1") or row.get("dest_nm") or ""),
            ),
            (
                str(row.get("DEST_CD2") or row.get("dest_cd2") or ""),
                str(row.get("DEST_NM2") or row.get("dest_nm2") or ""),
            ),
        ]
        for code, name in pairs:
            c = code.strip()
            if c and not any(d["code"] == c for d in rake["destinations"]):
                rake["destinations"].append({"code": c, "name": clean_rake_dest_name(name, c)})

    result = list(rake_map.values())
    result.sort(key=lambda r: _parse_created_at(r.get("createdAt")), reverse=True)
    return result
