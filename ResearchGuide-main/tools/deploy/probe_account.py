"""List existing Aliyun ECS. Prints no secrets."""
from __future__ import annotations

from aliyun_rpc import load_env, rpc

REGIONS = ["cn-hangzhou", "cn-beijing", "cn-shanghai", "cn-shenzhen"]


def ecs(ak, sk, region, action, params=None):
    return rpc(
        action,
        {"RegionId": region, **(params or {})},
        version="2014-05-26",
        endpoint=f"https://ecs.{region}.aliyuncs.com",
        ak=ak, sk=sk,
    )


def main() -> None:
    env = load_env()
    ak = env.get("AccessKey_ID") or env.get("ALIBABA_CLOUD_ACCESS_KEY_ID")
    sk = env.get("AccessKey_Secret") or env.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    if not ak or not sk:
        print("MISSING_KEYS")
        return
    print("AK_PREFIX", ak[:6], "len", len(ak), len(sk))
    for region in REGIONS:
        insts = ecs(ak, sk, region, "DescribeInstances", {"PageSize": 20})
        if insts.get("Code"):
            print(f"ECS {region} ERR {insts.get('Code')} {str(insts.get('Message', ''))[:200]}")
            continue
        items = (insts.get("Instances") or {}).get("Instance") or []
        print(f"ECS {region} n={len(items)}")
        for i in items:
            ips = ((i.get("PublicIpAddress") or {}).get("IpAddress")) or []
            print(" ", i.get("InstanceId"), i.get("Status"), i.get("InstanceType"), ips, i.get("InstanceName"))
        vpcs = ecs(ak, sk, region, "DescribeVpcs", {"PageSize": 10})
        vpc_list = ((vpcs.get("Vpcs") or {}).get("Vpc")) or []
        print(f"  VPC {len(vpc_list)}", [v.get("VpcId") for v in vpc_list[:5]])
        sgs = ecs(ak, sk, region, "DescribeSecurityGroups", {"PageSize": 10})
        sg_list = ((sgs.get("SecurityGroups") or {}).get("SecurityGroup")) or []
        print(f"  SG {len(sg_list)}", [s.get("SecurityGroupId") for s in sg_list[:5]])


if __name__ == "__main__":
    main()
