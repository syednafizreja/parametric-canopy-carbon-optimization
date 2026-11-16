"""Write reference fixtures from ShellForm's form finder for the ShellLab JS port.

Run with the ShellForm conda env and ShellForm's src on the path:
    python -I tools/make_fixtures.py <path-to-ShellForm>
The ShellForm commit is written into each fixture so the check is pinned.
"""
import json
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "src"))
from shellform import formfind as ff  # noqa: E402
from shellform import checks  # noqa: E402

rev = subprocess.run(["git", "-C", str(root), "describe", "--tags", "--always", "--dirty"],
                     capture_output=True, text=True, check=True).stdout.strip()
out = Path(__file__).resolve().parents[1] / "test" / "fixtures"
out.mkdir(parents=True, exist_ok=True)


def dump(name, net, plan, xyz, extra):
    loads = extra.pop("_loads")
    reactions = checks.support_reactions(xyz, net.edges, net.q, net.fixed)
    data = {
        "shellform": rev,
        "n_nodes": int(len(plan)),
        "plan": [[float(c) for c in row] for row in plan],
        "reactions": [[float(c) for c in row] for row in reactions],
        "edges": [[int(a), int(b)] for a, b in net.edges],
        "q": [float(v) for v in net.q],
        "fixed": [int(i) for i in net.fixed],
        "xyz": [[float(c) for c in row] for row in xyz],
        "equilibrium_error": float(checks.equilibrium_error(xyz, net.edges, net.q, loads, net.free)),
        **extra,
    }
    (out / f"{name}.json").write_text(json.dumps(data))
    print(name, rev, data["equilibrium_error"])


cases = [
    ("edges_12_r3", dict(span=12.0, n=9, sup="edges", rise=3.0, sa=(0.0, 0.0), fb=1.0)),
    ("edges_20_r4_sa", dict(span=20.0, n=13, sup="edges", rise=4.0, sa=(0.08, 0.0), fb=1.0)),
    ("corners_15_r3_fb5", dict(span=15.0, n=11, sup="corners", rise=3.0, sa=(0.0, 0.05), fb=5.0)),
    ("corners_30_r6_sa", dict(span=30.0, n=15, sup="corners", rise=6.0, sa=(0.1, 0.1), fb=12.0)),
]
for name, c in cases:
    net = ff.square_network(c["span"], c["n"], c["sup"], q_boundary_factor=c["fb"])
    plan = net.xyz.copy()
    xyz = ff.form_to_rise(net, c["rise"], sa_x=c["sa"][0], sa_y=c["sa"][1])
    loads = ff.plan_loads(net, sa_x=c["sa"][0], sa_y=c["sa"][1])
    dump(name, net, plan, xyz, {"case": dict(span=c["span"], n=c["n"], supports=c["sup"], rise=c["rise"],
                                       sa_x=c["sa"][0], sa_y=c["sa"][1], q_boundary_factor=c["fb"]),
                          "_loads": loads})

# Inset bisection (corner-supported)
for span, n, rise, ratio in [(20.0, 11, 4.0, 0.08), (30.0, 13, 6.0, 0.12)]:
    net, xyz, factor = ff.corner_network_for_inset(span, n, rise, ratio)
    plan = ff.square_network(span, n, "corners").xyz
    loads = ff.plan_loads(net)
    name = f"inset_{int(span)}_{int(ratio*100)}"
    dump(name, net, plan, xyz, {"case": dict(span=span, n=n, supports="corners", rise=rise, inset_ratio=ratio),
                          "factor": float(factor),
                          "inset": float(ff.edge_inset(xyz, plan, span)),
                          "_loads": loads})
