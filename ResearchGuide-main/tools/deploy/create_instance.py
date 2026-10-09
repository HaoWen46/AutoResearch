"""Create a Hangzhou ECS for 启研 if none exists. Writes tools/deploy/.deploy.env. No secrets to stdout."""
from __future__ import annotations

import secrets
import string
import time
from pathlib import Path

from aliyun_rpc import load_env, rpc

REGION = "cn-hangzhou"
VSW = "vsw-bp1sc0rvoguxibf3k7kqd"
SG = "sg-bp17r57q9ife6lusfx9y"
IMAGE = "ubuntu_22_04_x64_20G_alibase_20260916.vhd"
TYPES = ("ecs.e-c1m1.large", "ecs.u1-c1m1.large", "ecs.t6-c1m1.large")
STATE = Path(__file__).resolve().parent / ".deploy.env"


def ecs(ak, sk, action, params=None):
    return rpc(
        action,
        {"RegionId": REGION, **(params or {})},
        version="2014-05-26",
        endpoint=f"https://ecs.{REGION}.aliyuncs.com",
        ak=ak, sk=sk,
    )


def password() -> str:
    alphabet = string.ascii_letters + string.digits
    return "Qy" + "".join(secrets.choice(alphabet) for _ in range(12)) + "#"


def write_state(rows: dict[str, str]) -> None:
    old = {}
    if STATE.exists():
        for line in STATE.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                old[k] = v
    old.update(rows)
    STATE.write_text("".join(f"{k}={v}\n" for k, v in old.items()), encoding="utf-8")


def ensure_ports(ak, sk) -> None:
    attr = ecs(ak, sk, "DescribeSecurityGroupAttribute", {"SecurityGroupId": SG})
    perms = ((attr.get("Permissions") or {}).get("Permission")) or []
    open_ports = set()
    for p in perms:
        if p.get("Direction") == "ingress" and p.get("IpProtocol") in ("TCP", "ALL"):
            open_ports.add(str(p.get("PortRange")))
    print("SG ports", sorted(open_ports))
    for port in ("22/22", "80/80", "443/443"):
        if port in open_ports:
            continue
        r = ecs(ak, sk, "AuthorizeSecurityGroup", {
            "SecurityGroupId": SG,
            "IpProtocol": "TCP",
            "PortRange": port,
            "SourceCidrIp": "0.0.0.0/0",
            "Description": "qiyan",
        })
        print("open", port, r.get("Code") or "ok")


def main() -> None:
    env = load_env()
    ak, sk = env["AccessKey_ID"], env["AccessKey_Secret"]
    if STATE.exists() and "INSTANCE_ID" in STATE.read_text(encoding="utf-8"):
        print("STATE_EXISTS")
        print(STATE.read_text(encoding="utf-8").split("PASSWORD=", 1)[0])
        return
    existing = ecs(ak, sk, "DescribeInstances", {
        "InstanceName": "qiyan",
        "PageSize": 10,
    })
    items = ((existing.get("Instances") or {}).get("Instance")) or []
    if items:
        inst = items[0]
        ips = ((inst.get("PublicIpAddress") or {}).get("IpAddress")) or []
        write_state({
            "REGION": REGION,
            "INSTANCE_ID": inst["InstanceId"],
            "PUBLIC_IP": (ips[0] if ips else ""),
        })
        print("REUSE", inst["InstanceId"], ips)
        return
    ensure_ports(ak, sk)
    pw = password()
    last = None
    for typ in TYPES:
        r = ecs(ak, sk, "RunInstances", {
            "ImageId": IMAGE,
            "InstanceType": typ,
            "SecurityGroupId": SG,
            "VSwitchId": VSW,
            "InstanceName": "qiyan",
            "Password": pw,
            "PasswordInherit": "false",
            "InternetMaxBandwidthOut": 5,
            "InternetChargeType": "PayByTraffic",
            "InstanceChargeType": "PostPaid",
            "SystemDisk.Category": "cloud_essd",
            "SystemDisk.Size": 40,
            "Amount": 1,
            "MinAmount": 1,
        })
        last = r
        if not r.get("Code"):
            ids = ((r.get("InstanceIdSets") or {}).get("InstanceIdSet")) or []
            iid = ids[0] if ids else ""
            write_state({
                "REGION": REGION,
                "INSTANCE_ID": iid,
                "PASSWORD": pw,
                "INSTANCE_TYPE": typ,
            })
            print("CREATED", iid, typ)
            return
        print("TRY", typ, r.get("Code"), str(r.get("Message", ""))[:220])
    print("FAILED", last.get("Code") if last else "none", str((last or {}).get("Message", ""))[:300])


if __name__ == "__main__":
    main()
