# Parametric Carbon Optimization – Concrete Canopy

An interactive research prototype that links **geometry → structural response → material volume → embodied carbon** for a thin, doubly curved concrete shell canopy (12–18 m span) on tree-like branching supports, with thickened edge beams and tapered underside ribs. The viewport and parameter panel borrow their conventions from Rhino (display modes, isocurves, world axes, dimensions) and Grasshopper (slider components, solver-history plot).

> **Note.** This is a simplified research demonstration. Structural quantities are screening-level estimates that rank design alternatives; they are not a substitute for finite-element analysis or code verification.

## Use

Orbit with drag, zoom with scroll or pinch. Seven parameters (span, transverse rise, shell thickness, number of tree supports, rib spacing, longitudinal camber, crown shape factor) update the model, volume, carbon, deflection and utilization in real time. **Run optimization** animates the design toward a lower-carbon solution for the chosen span; **Reset** restores the reference design. Display modes (Rendered, Technical, Wireframe), layers (Ribs, Dims) and PNG export sit under the viewport. Percentages are relative to that reference.

## Model

| Step | Approach |
|---|---|
| Geometry | Mid-surface `y(ξ,η)` with leaf-shaped plan, crown exponent, camber; thickness grows toward the edges (edge beams). |
| Section | Area, centroid and second moment integrated numerically over the cross-section at 100 stations. |
| Ribs | Tapered plates under the shell; smeared T-section (50% efficiency) enters wing stiffness and panel buckling, and their volume enters mass and carbon. |
| Global response | Continuous girder on tree supports with half-bay cantilevers; three-moment equation; deflection by double integration of M/(E_eff·I), creep φ = 1.5. |
| Local response | Wing deflection with a shallow-shell stiffening surrogate; buckling of the transverse arch with a 0.25 knock-down factor. |
| Carbon | (shell + tree volume) × 2450 kg/m³ × 0.34 kgCO₂e/kg (cement-rich HPC/UHPFRC, cradle to gate). Ordinary C35/45 is roughly 0.13–0.16. |
| Fabrication | Maximum surface slope limited to 40° (single-sided formwork or sprayed casting). |
| Optimizer | Seeded (1+λ) evolution strategy; cost = carbon + 0.15 × deflection + penalties for utilization > 0.85 and slope > 40°. |

## Run locally and deploy

ES modules need a server: `python3 -m http.server`, then open `http://localhost:8000`.
For GitHub Pages, push the four files to the repository root and enable **Settings → Pages → Deploy from branch**.
Three.js r170 is loaded from jsDelivr through an import map in `index.html`.

## Limitations and next steps

Surrogates are calibrated by judgement, not against FE results. Natural next steps: shell FE or dynamic-relaxation coupling, funicular form-finding, a Pareto front over carbon and stiffness, and fabrication metrics for formwork.
