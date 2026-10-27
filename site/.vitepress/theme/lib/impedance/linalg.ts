/**
 * Small dense linear algebra for the impedance law: plain `number[]` / `number[][]`, sizes up to ~13 (the host-ceiling
 * closed loop at 1 kHz / 10 ms). No dependency.
 *
 * WHY hand-rolled and not a library: the law needs six things (matmul, solve, a symmetric eigensolver for the pseudo-inverse
 * and the matrix square root, and a general eigenvalue routine for the stability check) on 2x2 - 13x13 matrices; every
 * library that offers them is 30-300 kB and none promises numpy's conventions (pinv's relative cutoff on |eigenvalue|,
 * solve's exact-singular error). The golden vectors (tests/unit/law.golden.test.ts) are the proof these match numpy.
 */

export type Vec = number[]
export type Mat = number[][]

export class SingularMatrixError extends Error {
  constructor() {
    super('Singular matrix')
    this.name = 'SingularMatrixError'
  }
}

export function zeros(rows: number, cols: number): Mat {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
}

export function eye(size: number): Mat {
  const out = zeros(size, size)
  for (let i = 0; i < size; i++) out[i][i] = 1
  return out
}

export function clone(a: Mat): Mat {
  return a.map((row) => row.slice())
}

export function transpose(a: Mat): Mat {
  const rows = a.length
  const cols = rows ? a[0].length : 0
  const out = zeros(cols, rows)
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[j][i] = a[i][j]
  return out
}

export function matMul(a: Mat, b: Mat): Mat {
  const rows = a.length
  const inner = b.length
  const cols = inner ? b[0].length : 0
  const out = zeros(rows, cols)
  for (let i = 0; i < rows; i++) {
    const ai = a[i]
    const oi = out[i]
    for (let k = 0; k < inner; k++) {
      const aik = ai[k]
      if (aik === 0) continue
      const bk = b[k]
      for (let j = 0; j < cols; j++) oi[j] += aik * bk[j]
    }
  }
  return out
}

/** a @ b @ c */
export function matMul3(a: Mat, b: Mat, c: Mat): Mat {
  return matMul(matMul(a, b), c)
}

export function matVec(a: Mat, x: Vec): Vec {
  return a.map((row) => {
    let sum = 0
    for (let j = 0; j < row.length; j++) sum += row[j] * x[j]
    return sum
  })
}

/** a^T x without forming the transpose. */
export function matTVec(a: Mat, x: Vec): Vec {
  const cols = a.length ? a[0].length : 0
  const out = new Array<number>(cols).fill(0)
  for (let i = 0; i < a.length; i++) {
    const xi = x[i]
    if (xi === 0) continue
    for (let j = 0; j < cols; j++) out[j] += a[i][j] * xi
  }
  return out
}

export function matAdd(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((value, j) => value + b[i][j]))
}

export function matSub(a: Mat, b: Mat): Mat {
  return a.map((row, i) => row.map((value, j) => value - b[i][j]))
}

export function matScale(a: Mat, factor: number): Mat {
  return a.map((row) => row.map((value) => value * factor))
}

export function vecAdd(a: Vec, b: Vec): Vec {
  return a.map((value, i) => value + b[i])
}

export function vecSub(a: Vec, b: Vec): Vec {
  return a.map((value, i) => value - b[i])
}

export function vecScale(a: Vec, factor: number): Vec {
  return a.map((value) => value * factor)
}

export function dot(a: Vec, b: Vec): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export function norm(a: Vec): number {
  return Math.sqrt(dot(a, a))
}

export function diag(values: Vec): Mat {
  const out = zeros(values.length, values.length)
  for (let i = 0; i < values.length; i++) out[i][i] = values[i]
  return out
}

export function diagOf(a: Mat): Vec {
  return a.map((row, i) => row[i])
}

/** a - diag(diag(a)) */
export function offDiagonal(a: Mat): Mat {
  return a.map((row, i) => row.map((value, j) => (i === j ? 0 : value)))
}

/** 0.5 (a + a^T) */
export function symmetrize(a: Mat): Mat {
  return a.map((row, i) => row.map((value, j) => 0.5 * (value + a[j][i])))
}

/** blockdiag(a, b) */
export function blockDiag(a: Mat, b: Mat): Mat {
  const size = a.length + b.length
  const out = zeros(size, size)
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) out[i][j] = a[i][j]
  const offset = a.length
  for (let i = 0; i < b.length; i++) for (let j = 0; j < b.length; j++) out[offset + i][offset + j] = b[i][j]
  return out
}

/**
 * Solve A X = B by LU with partial pivoting (LAPACK gesv's algorithm). Throws SingularMatrixError on an exactly zero pivot,
 * as numpy.linalg.solve raises LinAlgError.
 */
export function solve(a: Mat, b: Mat): Mat
export function solve(a: Mat, b: Vec): Vec
export function solve(a: Mat, b: Mat | Vec): Mat | Vec {
  const size = a.length
  const lu = clone(a)
  const vector = !Array.isArray(b[0])
  const rhs: Mat = vector ? (b as Vec).map((value) => [value]) : clone(b as Mat)
  const cols = rhs.length ? rhs[0].length : 0
  for (let k = 0; k < size; k++) {
    let pivot = k
    let best = Math.abs(lu[k][k])
    for (let i = k + 1; i < size; i++) {
      const value = Math.abs(lu[i][k])
      if (value > best) {
        best = value
        pivot = i
      }
    }
    if (best === 0) throw new SingularMatrixError()
    if (pivot !== k) {
      ;[lu[k], lu[pivot]] = [lu[pivot], lu[k]]
      ;[rhs[k], rhs[pivot]] = [rhs[pivot], rhs[k]]
    }
    const pivotValue = lu[k][k]
    for (let i = k + 1; i < size; i++) {
      const factor = lu[i][k] / pivotValue
      if (factor === 0) continue
      lu[i][k] = factor
      for (let j = k + 1; j < size; j++) lu[i][j] -= factor * lu[k][j]
      for (let j = 0; j < cols; j++) rhs[i][j] -= factor * rhs[k][j]
    }
  }
  for (let k = size - 1; k >= 0; k--) {
    for (let j = 0; j < cols; j++) {
      let sum = rhs[k][j]
      for (let i = k + 1; i < size; i++) sum -= lu[k][i] * rhs[i][j]
      rhs[k][j] = sum / lu[k][k]
    }
  }
  return vector ? rhs.map((row) => row[0]) : rhs
}

export function inv(a: Mat): Mat {
  return solve(a, eye(a.length))
}

export interface SymmetricEigen {
  values: Vec
  /** columns are the eigenvectors: vectors[i][k] is component i of eigenvector k */
  vectors: Mat
}

/**
 * Eigen-decomposition of a symmetric matrix by the cyclic Jacobi method (accurate to machine precision on the small
 * matrices the law sees). The whole matrix is read, so pass a symmetric one: callers symmetrize first, where numpy's eigh
 * would read one triangle.
 */
export function eighJacobi(input: Mat): SymmetricEigen {
  const size = input.length
  const a = clone(input)
  const v = eye(size)
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    let scale = 0
    for (let i = 0; i < size; i++) {
      scale += a[i][i] * a[i][i]
      for (let j = i + 1; j < size; j++) off += a[i][j] * a[i][j]
    }
    if (off === 0 || off <= 1e-34 * scale) break
    for (let p = 0; p < size - 1; p++) {
      for (let q = p + 1; q < size; q++) {
        const apq = a[p][q]
        if (apq === 0) continue
        const app = a[p][p]
        const aqq = a[q][q]
        const theta = (aqq - app) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < size; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < size; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        a[p][q] = 0
        a[q][p] = 0
        for (let k = 0; k < size; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v }
}

/** V f(lambda) V^T for a symmetric matrix. */
function spectralMap(eigen: SymmetricEigen, map: (value: number) => number): Mat {
  const size = eigen.values.length
  const mapped = eigen.values.map(map)
  const out = zeros(size, size)
  for (let k = 0; k < size; k++) {
    const weight = mapped[k]
    if (weight === 0) continue
    for (let i = 0; i < size; i++) {
      const vik = eigen.vectors[i][k] * weight
      if (vik === 0) continue
      for (let j = 0; j < size; j++) out[i][j] += vik * eigen.vectors[j][k]
    }
  }
  return out
}

/**
 * numpy.linalg.pinv(a, rcond, hermitian=True): eigenvalues with |lambda| <= rcond * max|lambda| are dropped, the rest
 * inverted.
 */
export function pinvHermitian(a: Mat, rcond: number): Mat {
  const eigen = eighJacobi(a)
  const largest = Math.max(0, ...eigen.values.map(Math.abs))
  const cutoff = rcond * largest
  return spectralMap(eigen, (value) => (Math.abs(value) > cutoff ? 1 / value : 0))
}

/** The symmetric square root of 0.5 (a + a^T), negative eigenvalues clipped to zero (law._symmetric_root). */
export function symmetricRoot(a: Mat): Mat {
  return spectralMap(eighJacobi(symmetrize(a)), (value) => Math.sqrt(Math.max(value, 0)))
}

/**
 * Balance a matrix in place by a diagonal similarity of powers of two (EISPACK balanc without the permutations), so its row
 * and column norms are comparable. WHY: the host-ceiling closed loop mixes wn^2 ~ 1e5 with input gains ~ 1e-7; without
 * balancing its eigenvalues lose ~7 digits (measured against numpy's eigvals, which balances via LAPACK gebal).
 */
function balance(a: Mat): Mat {
  const size = a.length
  const radix = 2
  const squared = radix * radix
  let done = false
  while (!done) {
    done = true
    for (let i = 0; i < size; i++) {
      let r = 0
      let c = 0
      for (let j = 0; j < size; j++)
        if (j !== i) {
          c += Math.abs(a[j][i])
          r += Math.abs(a[i][j])
        }
      if (c !== 0 && r !== 0) {
        let g = r / radix
        let f = 1
        const s = c + r
        while (c < g) {
          f *= radix
          c *= squared
        }
        g = r * radix
        while (c > g) {
          f /= radix
          c /= squared
        }
        if ((c + r) / f < 0.95 * s) {
          done = false
          g = 1 / f
          for (let j = 0; j < size; j++) a[i][j] *= g
          for (let j = 0; j < size; j++) a[j][i] *= f
        }
      }
    }
  }
  return a
}

/**
 * Eigenvalues of a general real matrix: balancing, Householder reduction to Hessenberg form, then the shifted double QR
 * iteration (EISPACK balanc + orthes + hqr, as in JAMA). Returns real and imaginary parts.
 */
export function eigenvalues(input: Mat): { re: Vec; im: Vec } {
  const size = input.length
  const h = balance(clone(input))
  // orthes: Householder similarity to upper Hessenberg form
  const ort = new Array<number>(size).fill(0)
  const high = size - 1
  for (let m = 1; m <= high - 1; m++) {
    let scale = 0
    for (let i = m; i <= high; i++) scale += Math.abs(h[i][m - 1])
    if (scale !== 0) {
      let hh = 0
      for (let i = high; i >= m; i--) {
        ort[i] = h[i][m - 1] / scale
        hh += ort[i] * ort[i]
      }
      let g = Math.sqrt(hh)
      if (ort[m] > 0) g = -g
      hh -= ort[m] * g
      ort[m] -= g
      for (let j = m; j < size; j++) {
        let f = 0
        for (let i = high; i >= m; i--) f += ort[i] * h[i][j]
        f /= hh
        for (let i = m; i <= high; i++) h[i][j] -= f * ort[i]
      }
      for (let i = 0; i <= high; i++) {
        let f = 0
        for (let j = high; j >= m; j--) f += ort[j] * h[i][j]
        f /= hh
        for (let j = m; j <= high; j++) h[i][j] -= f * ort[j]
      }
      ort[m] = scale * ort[m]
      h[m][m - 1] = scale * g
    }
  }
  // hqr: eigenvalues of the Hessenberg matrix
  const re = new Array<number>(size).fill(0)
  const im = new Array<number>(size).fill(0)
  const nn = size
  let n = nn - 1
  const low = 0
  const eps = 2 ** -52
  let exshift = 0
  let p = 0
  let q = 0
  let r = 0
  let s = 0
  let z = 0
  let w: number
  let x: number
  let y: number
  let matrixNorm = 0
  for (let i = 0; i < nn; i++) for (let j = Math.max(i - 1, 0); j < nn; j++) matrixNorm += Math.abs(h[i][j])
  let iter = 0
  let totalIterations = 0
  while (n >= low) {
    let l = n
    while (l > low) {
      s = Math.abs(h[l - 1][l - 1]) + Math.abs(h[l][l])
      if (s === 0) s = matrixNorm
      if (Math.abs(h[l][l - 1]) < eps * s) break
      l--
    }
    if (l === n) {
      h[n][n] += exshift
      re[n] = h[n][n]
      im[n] = 0
      n--
      iter = 0
    } else if (l === n - 1) {
      w = h[n][n - 1] * h[n - 1][n]
      p = (h[n - 1][n - 1] - h[n][n]) / 2
      q = p * p + w
      z = Math.sqrt(Math.abs(q))
      h[n][n] += exshift
      h[n - 1][n - 1] += exshift
      x = h[n][n]
      if (q >= 0) {
        z = p >= 0 ? p + z : p - z
        re[n - 1] = x + z
        re[n] = re[n - 1]
        if (z !== 0) re[n] = x - w / z
        im[n - 1] = 0
        im[n] = 0
        x = h[n][n - 1]
        s = Math.abs(x) + Math.abs(z)
        p = x / s
        q = z / s
        r = Math.sqrt(p * p + q * q)
        p /= r
        q /= r
        for (let j = n - 1; j < nn; j++) {
          z = h[n - 1][j]
          h[n - 1][j] = q * z + p * h[n][j]
          h[n][j] = q * h[n][j] - p * z
        }
        for (let i = 0; i <= n; i++) {
          z = h[i][n - 1]
          h[i][n - 1] = q * z + p * h[i][n]
          h[i][n] = q * h[i][n] - p * z
        }
      } else {
        re[n - 1] = x + p
        re[n] = x + p
        im[n - 1] = z
        im[n] = -z
      }
      n -= 2
      iter = 0
    } else {
      x = h[n][n]
      y = 0
      w = 0
      if (l < n) {
        y = h[n - 1][n - 1]
        w = h[n][n - 1] * h[n - 1][n]
      }
      if (iter === 10) {
        exshift += x
        for (let i = low; i <= n; i++) h[i][i] -= x
        s = Math.abs(h[n][n - 1]) + Math.abs(h[n - 1][n - 2])
        x = y = 0.75 * s
        w = -0.4375 * s * s
      }
      if (iter === 30) {
        s = (y - x) / 2
        s = s * s + w
        if (s > 0) {
          s = Math.sqrt(s)
          if (y < x) s = -s
          s = x - w / ((y - x) / 2 + s)
          for (let i = low; i <= n; i++) h[i][i] -= s
          exshift += s
          x = y = w = 0.964
        }
      }
      iter++
      totalIterations++
      if (totalIterations > 1000 * nn) throw new Error('eigenvalues: QR iteration did not converge')
      let m = n - 2
      while (m >= l) {
        z = h[m][m]
        r = x - z
        s = y - z
        p = (r * s - w) / h[m + 1][m] + h[m][m + 1]
        q = h[m + 1][m + 1] - z - r - s
        r = h[m + 2][m + 1]
        s = Math.abs(p) + Math.abs(q) + Math.abs(r)
        p /= s
        q /= s
        r /= s
        if (m === l) break
        if (
          Math.abs(h[m][m - 1]) * (Math.abs(q) + Math.abs(r)) <
          eps * (Math.abs(p) * (Math.abs(h[m - 1][m - 1]) + Math.abs(z) + Math.abs(h[m + 1][m + 1])))
        )
          break
        m--
      }
      for (let i = m + 2; i <= n; i++) {
        h[i][i - 2] = 0
        if (i > m + 2) h[i][i - 3] = 0
      }
      for (let k = m; k <= n - 1; k++) {
        const notLast = k !== n - 1
        if (k !== m) {
          p = h[k][k - 1]
          q = h[k + 1][k - 1]
          r = notLast ? h[k + 2][k - 1] : 0
          x = Math.abs(p) + Math.abs(q) + Math.abs(r)
          if (x === 0) continue
          p /= x
          q /= x
          r /= x
        }
        s = Math.sqrt(p * p + q * q + r * r)
        if (p < 0) s = -s
        if (s !== 0) {
          if (k !== m) h[k][k - 1] = -s * x
          else if (l !== m) h[k][k - 1] = -h[k][k - 1]
          p += s
          x = p / s
          y = q / s
          z = r / s
          q /= p
          r /= p
          for (let j = k; j < nn; j++) {
            p = h[k][j] + q * h[k + 1][j]
            if (notLast) {
              p += r * h[k + 2][j]
              h[k + 2][j] -= p * z
            }
            h[k][j] -= p * x
            h[k + 1][j] -= p * y
          }
          for (let i = 0; i <= Math.min(n, k + 3); i++) {
            p = x * h[i][k] + y * h[i][k + 1]
            if (notLast) {
              p += z * h[i][k + 2]
              h[i][k + 2] -= p * r
            }
            h[i][k] -= p
            h[i][k + 1] -= p * q
          }
        }
      }
    }
  }
  return { re, im }
}

/** max |eigenvalue| */
export function spectralRadius(a: Mat): number {
  const { re, im } = eigenvalues(a)
  let largest = 0
  for (let i = 0; i < re.length; i++) largest = Math.max(largest, Math.hypot(re[i], im[i]))
  return largest
}
