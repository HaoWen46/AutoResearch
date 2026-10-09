"""Inspect Hangzhou VPC / images / instance types. No secrets printed."""
from __future__ import annotations

from aliyun_rpc import load_env, rpc

REGION = "cn-hangzhou"
VPC = "vpc-bp13h9zi94rbzzyr7yxer"


def ecs(ak, sk, action, params=None):
    return rpc(
        action,
        {"RegionId": REGION, **(params or {})},
        version="2014-05-26",
        endpoint=f"https://ecs.{REGION}.aliyuncs.com",
        ak=ak, sk=sk,
    )


def main() -> None:
    env = load_env()
    ak = env["AccessKey_ID"]
    sk = env["AccessKey_Secret"]
    vs = ecs(ak, sk, "DescribeVSwitches", {"VpcId": VPC, "PageSize": 20})
    if vs.get("Code"):
        print("VSW ERR", vs.get("Code"), vs.get("Message", "")[:200])
    else:
        items = ((vs.get("VSwitches") or {}).get("VSwitch")) or []
        print("VSW", len(items))
        for i in items:
            print(" ", i.get("VSwitchId"), i.get("ZoneId"), i.get("AvailableIpAddressCount"), i.get("CidrBlock"))
    img = ecs(ak, sk, "DescribeImages", {
        "ImageOwnerAlias": "system",
        "OSType": "linux",
        "PageSize": 20,
        "ImageFamily": "acs:ubuntu_22_04_x64",
    })
    if img.get("Code"):
        print("IMG family ERR", img.get("Code"), str(img.get("Message", ""))[:200])
        img = ecs(ak, sk, "DescribeImages", {
            "ImageOwnerAlias": "system",
            "OSType": "linux",
            "PageSize": 30,
        })
    images = ((img.get("Images") or {}).get("Image")) or []
    print("IMG", len(images))
    for i in images:
        name = i.get("ImageName") or ""
        if "ubuntu" in name.lower() or "Ubuntu" in (i.get("OSName") or ""):
            print(" ", i.get("ImageId"), i.get("OSName"), name)
    avail = ecs(ak, sk, "DescribeAvailableResource", {
        "DestinationResource": "InstanceType",
        "InstanceChargeType": "PostPaid",
        "NetworkCategory": "vpc",
        "ResourceType": "instance",
    })
    print("AVAIL code", avail.get("Code"), str(avail.get("Message", ""))[:180])
    # try a few cheap types
    for t in ("ecs.e-c1m1.large", "ecs.u1-c1m1.large", "ecs.t6-c1m1.large", "ecs.n4.small", "ecs.e-c1m2.large"):
        r = ecs(ak, sk, "DescribeInstanceTypes", {"InstanceTypes.1": t})
        types = ((r.get("InstanceTypes") or {}).get("InstanceType")) or []
        print("TYPE", t, "ok" if types else r.get("Code"), types[0].get("MemorySize") if types else "")


if __name__ == "__main__":
    main()
