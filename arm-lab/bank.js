// Each site is a separate recording session with a fixed mounting position.
export const sites = {
  flexors: {
    name: "Palm-side forearm",
    placement: "Support your forearm palm up. Find the fleshy area that firms during a gentle grip. Center MID there with END along the forearm toward the wrist, clear of the wrist tendons. Keep the three pads in place for both labels.",
    reference: "Make a comfortable loose fist with the wrist straight.",
    moves: [
      { id: "grip", name: "Close hand", cue: "Keep the wrist straight. Gently curl the fingers into a loose fist, then hold until the rest cue." },
      { id: "wrist_flexion", name: "Wrist flexion", cue: "Support the forearm palm up with the hand free. Keep the fingers soft and bend the palm toward the forearm." }
    ]
  },
  extensors: {
    name: "Back of forearm",
    placement: "Support the forearm palm down. Feel for the muscle belly on the back of the forearm that firms when lifting the back of the hand. Center MID there and aim END along the fibers toward the wrist. Keep REF in contact.",
    reference: "Lift the back of the hand comfortably with fingers loose.",
    moves: [
      { id: "wrist_extension", name: "Wrist extension", cue: "Rest the forearm palm down with the hand free. Keeping the fingers loose, lift the back of your hand at the wrist." },
      { id: "hand_open", name: "Open hand", cue: "Keep the wrist still. From loosely curled fingers, straighten them together as though releasing a game piece." }
    ]
  },
  biceps: {
    name: "Front of upper arm",
    placement: "Center MID over the biceps belly on the front of the upper arm, roughly one third of the way from the elbow crease toward the shoulder. Align END along the muscle. Keep REF in contact.",
    reference: "Gently bend the elbow with the palm facing up.",
    moves: [
      { id: "elbow_flexion", name: "Elbow flexion", cue: "With the upper arm beside you and palm up, bend your elbow as though bringing an empty cup toward you." },
      { id: "supination", name: "Turn palm up", cue: "Start thumb up with the elbow bent beside you. Turn the palm upward without lifting your elbow or rotating your shoulder." }
    ]
  }
};
