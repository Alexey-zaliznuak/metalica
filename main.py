def solve():
    n, k = map(int, input().split())

    a = list(map(int, input().split()))
    b = list(map(int, input().split()))

    d = sorted(b[i] - a[i] for i in range(n))

    # сколько надо исправить
    m = n - k

    if m == 0:
        print(0)
        return

    pref = [0] * (n + 1)
    for i in range(n):
        pref[i + 1] = pref[i] + d[i]

    ans = 10**30

    # n длинна
    # m сколько надо исправить
    for l in range(n - m + 1):
        r = l + m
        mid = (l + r - 1) // 2
        median = d[mid]

        # сумма d[i]-median слева от медианы
        left = median * (mid - l) - (pref[mid] - pref[l])

        # сумма median - d[i] справа от медианы
        right = -1 * (median * (r - mid - 1) - (pref[r] - pref[mid + 1]))

        ans = min(ans, left + right)

    print(ans)

solve()
