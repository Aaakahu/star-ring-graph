import math, random

def force_layout(n, edges, seed=42):
    random.seed(seed)
    nodes = [{'id': i, 'x': 0, 'y': 0, 'chap': random.randint(0,2)} for i in range(n)]
    nodes[0]['x'] = 0; nodes[0]['y'] = 0
    initR = 70
    for i in range(1, n):
        a = 2 * math.pi * (i / max(n-1, 1))
        nodes[i]['x'] = math.cos(a) * initR
        nodes[i]['y'] = math.sin(a) * initR
    REPULSION=8000; IDEAL_DIST=80; SPRING_K=0.15; CENTER_PULL=0.02; DAMPING=0.85; ITER=60
    vel = [{'x':0,'y':0} for _ in range(n)]
    for it in range(ITER):
        force = [{'x':0,'y':0} for _ in range(n)]
        for i in range(n):
            for j in range(i+1,n):
                dx=nodes[j]['x']-nodes[i]['x']; dy=nodes[j]['y']-nodes[i]['y']
                dist=math.hypot(dx,dy) or 0.01; rep=REPULSION/(dist*dist)
                ux,uy=dx/dist,dy/dist
                force[i]['x']-=ux*rep; force[i]['y']-=uy*rep
                force[j]['x']+=ux*rep; force[j]['y']+=uy*rep
        for s,t in edges:
            dx=nodes[t]['x']-nodes[s]['x']; dy=nodes[t]['y']-nodes[s]['y']
            dist=math.hypot(dx,dy) or 0.01; f=SPRING_K*(dist-IDEAL_DIST)
            ux,uy=dx/dist,dy/dist
            force[s]['x']+=ux*f; force[s]['y']+=uy*f
            force[t]['x']-=ux*f; force[t]['y']-=uy*f
        for i in range(n):
            force[i]['x']-=nodes[i]['x']*CENTER_PULL; force[i]['y']-=nodes[i]['y']*CENTER_PULL
            vel[i]['x']=(vel[i]['x']+force[i]['x'])*DAMPING; vel[i]['y']=(vel[i]['y']+force[i]['y'])*DAMPING
            nodes[i]['x']+=vel[i]['x']; nodes[i]['y']+=vel[i]['y']
    return nodes

print('=== 力导向在多场景的表现 ===')
print()

# 场景1：单章 20 节点（密集连接）
print('--- 场景1：单章 20 节点，密集连接（模拟泰勒查询）---')
edges = [(i, i+1) for i in range(19)] + [(i, i+2) for i in range(18)]
nodes = force_layout(20, edges)
xs = [n['x'] for n in nodes]; ys = [n['y'] for n in nodes]
print(f'  坐标范围: X={max(xs)-min(xs):.0f}px Y={max(ys)-min(ys):.0f}px')

# 场景2：跨章 20 节点（3 个星团，章内连接密，章间无连接）
print()
print('--- 场景2：跨章 20 节点，3个星团（章内密连，章间无连）---')
edges = []
for ch in range(3):
    base = ch * 7
    for i in range(base, base+6):
        edges.append((i, i+1))
nodes = force_layout(20, edges)
# 按 chapter 分组看是否自然分离
from collections import defaultdict
by_chap = defaultdict(list)
for n in nodes:
    by_chap[n['chap']].append((n['x'], n['y']))
print(f'  坐标范围: X={max(xs)-min(xs):.0f}px Y={max(ys)-min(ys):.0f}px')
for ch, pts in by_chap.items():
    cxs = [p[0] for p in pts]; cys = [p[1] for p in pts]
    print(f'  章节{ch} ({len(pts)}节点): 中心=({sum(cxs)/len(cxs):.0f},{sum(cys)/len(cys):.0f}) 范围={max(cxs)-min(cxs):.0f}x{max(cys)-min(cys):.0f}')

# 场景3：极端 50 节点（未来 limit 放宽）
print()
print('--- 场景3：50 节点压力测试 ---')
edges = [(i, (i+1)%50) for i in range(50)]
nodes = force_layout(50, edges, seed=7)
xs = [n['x'] for n in nodes]; ys = [n['y'] for n in nodes]
diag = math.hypot(max(xs)-min(xs), max(ys)-min(ys))
print(f'  坐标范围: X={max(xs)-min(xs):.0f}px Y={max(ys)-min(ys):.0f}px 对角线={diag:.0f}px')
# 检查有无重叠（节点间距 < 30px 算重叠）
overlaps = 0
for i in range(50):
    for j in range(i+1, 50):
        d = math.hypot(nodes[i]['x']-nodes[j]['x'], nodes[i]['y']-nodes[j]['y'])
        if d < 30: overlaps += 1
print(f'  重叠对数(间距<30px): {overlaps}')

# 场景4：100 节点（极限）
print()
print('--- 场景4：100 节点极限测试 ---')
edges = [(i, (i+1)%100) for i in range(100)]
nodes = force_layout(100, edges, seed=7)
xs = [n['x'] for n in nodes]; ys = [n['y'] for n in nodes]
diag = math.hypot(max(xs)-min(xs), max(ys)-min(ys))
overlaps = sum(1 for i in range(100) for j in range(i+1,100)
               if math.hypot(nodes[i]['x']-nodes[j]['x'], nodes[i]['y']-nodes[j]['y']) < 25)
print(f'  坐标范围: X={max(xs)-min(xs):.0f}px Y={max(ys)-min(ys):.0f}px 对角线={diag:.0f}px')
print(f'  重叠对数(间距<25px): {overlaps}')
