//! Planar stereo audio (detailed design 4.1).

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stereo {
    pub l: Vec<f32>,
    pub r: Vec<f32>,
}

impl Stereo {
    pub fn new(l: Vec<f32>, r: Vec<f32>) -> Self {
        assert_eq!(l.len(), r.len(), "channels must have the same length");
        Self { l, r }
    }

    pub fn zeros(frames: usize) -> Self {
        Self {
            l: vec![0.0; frames],
            r: vec![0.0; frames],
        }
    }

    pub fn len(&self) -> usize {
        self.l.len()
    }

    pub fn is_empty(&self) -> bool {
        self.l.is_empty()
    }

    pub fn scaled(&self, gain: f32) -> Self {
        Self {
            l: self.l.iter().map(|s| s * gain).collect(),
            r: self.r.iter().map(|s| s * gain).collect(),
        }
    }

    pub fn scale(&mut self, gain: f32) {
        self.l
            .iter_mut()
            .chain(self.r.iter_mut())
            .for_each(|s| *s *= gain);
    }

    pub fn channels(&self) -> [&[f32]; 2] {
        [&self.l, &self.r]
    }

    pub fn channels_mut(&mut self) -> [&mut Vec<f32>; 2] {
        [&mut self.l, &mut self.r]
    }
}
