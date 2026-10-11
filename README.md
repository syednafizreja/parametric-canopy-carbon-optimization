# Parametric Carbon Optimization – Concrete Canopy

Interactive research prototype that links **geometry → structural response → material volume → embodied carbon** for a thin, doubly-curved concrete shell canopy (12–18 m span) supported by tree-like branching columns with thickened edge beams.

> **Note.** This is a simplified research demonstration. Structural quantities are screening-level estimates intended to rank design alternatives. They are not a substitute for finite-element analysis or code verification.

## Live demo
After enabling GitHub Pages the project will be available at:  
`https://YOUR_USERNAME.github.io/parametric-carbon-optimization/`

## Interaction
- Drag to orbit, scroll / pinch to zoom
- Six parameters update geometry, volume, carbon, deflection and utilization in real time
- **Run Optimization** animates the design toward a lower-carbon solution for the chosen span
- **Reset** restores the reference design
- Percentages are relative to the reference configuration

## Model summary
| Aspect | Approach |
|--------|----------|
| Geometry | Leaf-shaped plan, crown exponent, longitudinal camber, edge-beam thickening |
| Section | Numerical integration of area, centroid and second moment at 100 stations |
| Global response | Continuous girder on tree supports (three-moment equation) + creep-reduced stiffness |
| Local response | Shallow-shell wing deflection + knocked-down arch buckling |
| Carbon | (shell + trees) × 2450 kg/m³ × 0.34 kgCO₂e/kg (HPC/UHPFRC, cradle-to-gate) |
| Optimizer | Seeded (1+λ) evolution strategy with utilization and slope penalties |

## Author
**Syed Nafiz Reja Hasib**  
Civil Engineering · Interests: sustainable materials, parametric structural design, digital construction

## Technical notes
Pure HTML + CSS + ES modules. Three.js r170 loaded via jsDelivr. No build step required. For local testing use any static server (`python3 -m http.server`).
