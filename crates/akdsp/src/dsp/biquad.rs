//! Biquad filters (RBJ cookbook), processed in f64.
use core::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn normalized(b: [f64; 3], a: [f64; 3]) -> Self {
        Self { b0: b[0] / a[0], b1: b[1] / a[0], b2: b[2] / a[0], a1: a[1] / a[0], a2: a[2] / a[0], z1: 0.0, z2: 0.0 }
    }

    pub fn high_shelf(sr: f64, freq: f64, gain_db: f64, q: f64) -> Self {
        let a = libm::pow(10.0, gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let (c, alpha) = (libm::cos(w0), libm::sin(w0) / (2.0 * q));
        let sa = 2.0 * libm::sqrt(a) * alpha;
        Self::normalized(
            [a * ((a + 1.0) + (a - 1.0) * c + sa), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - sa)],
            [(a + 1.0) - (a - 1.0) * c + sa, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - sa],
        )
    }

    pub fn low_shelf(sr: f64, freq: f64, gain_db: f64, q: f64) -> Self {
        let a = libm::pow(10.0, gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let (c, alpha) = (libm::cos(w0), libm::sin(w0) / (2.0 * q));
        let sa = 2.0 * libm::sqrt(a) * alpha;
        Self::normalized(
            [a * ((a + 1.0) - (a - 1.0) * c + sa), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - sa)],
            [(a + 1.0) + (a - 1.0) * c + sa, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - sa],
        )
    }

    pub fn low_pass(sr: f64, freq: f64, q: f64) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let (c, alpha) = (libm::cos(w0), libm::sin(w0) / (2.0 * q));
        Self::normalized([(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0], [1.0 + alpha, -2.0 * c, 1.0 - alpha])
    }

    pub fn high_pass(sr: f64, freq: f64, q: f64) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let (c, alpha) = (libm::cos(w0), libm::sin(w0) / (2.0 * q));
        Self::normalized([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [1.0 + alpha, -2.0 * c, 1.0 - alpha])
    }

    #[inline]
    pub fn tick(&mut self, x: f64) -> f64 {
        // Transposed direct form II.
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            *s = self.tick(f64::from(*s)) as f32;
        }
    }
}
